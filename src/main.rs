#![cfg_attr(not(debug_assertions), windows_subsystem = "windows")]

mod api;
mod model;

use crate::model::*;
use serde::{Deserialize, Serialize};
use std::collections::{HashMap, HashSet};
use std::fs;
use std::mem::size_of;
use std::path::PathBuf;
use std::sync::atomic::{AtomicBool, AtomicU32, Ordering};
use std::sync::mpsc::{self, Receiver, Sender};
use std::sync::{Arc, Mutex, OnceLock};
use std::thread;
use std::time::{Duration, Instant, SystemTime, UNIX_EPOCH};
use windows::core::{w, PCWSTR};
use windows::Win32::Foundation::*;
use windows::Win32::Graphics::Gdi::*;
use windows::Win32::System::LibraryLoader::GetModuleHandleW;
use windows::Win32::System::ProcessStatus::{
    GetPerformanceInfo, K32GetProcessMemoryInfo, PERFORMANCE_INFORMATION,
    PROCESS_MEMORY_COUNTERS_EX,
};
use windows::Win32::System::Threading::{OpenProcess, PROCESS_QUERY_INFORMATION, PROCESS_VM_READ};
use windows::Win32::UI::HiDpi::{
    SetProcessDpiAwarenessContext, DPI_AWARENESS_CONTEXT_PER_MONITOR_AWARE_V2,
};
use windows::Win32::UI::Input::KeyboardAndMouse::{ReleaseCapture, SetCapture};
use windows::Win32::UI::WindowsAndMessaging::*;

const CLASS_NAME: PCWSTR = w!("OCXNotchWindow");
const WM_DATA: u32 = WM_APP + 1;
const MENU_REFRESH: usize = 1;
const MENU_EXIT: usize = 2;
const MENU_THRESHOLD_DOWN: usize = 3;
const MENU_THRESHOLD_UP: usize = 4;
const MENU_THRESHOLD_BASE: usize = 1_000;
const DEFAULT_WIDTH: i32 = 640;
const MIN_WIDTH: i32 = 320;
const MAX_WIDTH: i32 = 1_200;
const RESIZE_EDGE: i32 = 7;
const COLLAPSED_HEIGHT: i32 = 58;
const USAGE_TOGGLE_HEIGHT: i32 = 42;
const HEADER_TEXT_RIGHT: i32 = 132;
const HEADER_CHART_LEFT: i32 = 140;
const HEADER_LABEL_WIDTH: i32 = 82;
const HEADER_LABEL_GAP: i32 = 8;
const ACCOUNT_IDENTITY_LEFT: i32 = 42;
const ACCOUNT_ACTION_WIDTH: i32 = 26;
const ACCOUNT_ACTION_HEIGHT: i32 = 30;
const ACCOUNT_ACTION_GAP: i32 = 4;
const GIB: u64 = 1024 * 1024 * 1024;

static APP: OnceLock<Mutex<App>> = OnceLock::new();
static LUCIDE_FONT_BYTES: &[u8] = include_bytes!("../assets/lucide-subset.ttf");

#[derive(Clone, Copy, PartialEq, Eq)]
enum Button {
    Power,
    Minimize,
}

#[derive(Clone, PartialEq, Eq)]
struct AccountControl {
    id: String,
    paused: bool,
}

#[derive(Clone, Copy)]
enum ResizeEdge {
    Left,
    Right,
}

#[derive(Clone, Copy, Deserialize, Serialize)]
struct WindowPlacement {
    x: i32,
    y: i32,
    width: i32,
}

#[derive(Clone, Copy, Default)]
struct SystemMemory {
    physical_total: u64,
    physical_available: u64,
    commit_total: u64,
    commit_limit: u64,
}

#[derive(Clone, Copy, PartialEq, Eq)]
enum PressureLevel {
    Stable,
    Caution,
    Danger,
}

enum Update {
    NativeMemory {
        pid: u32,
        working_set: u64,
        private_commit: u64,
        system_memory: Option<SystemMemory>,
    },
    Health(Result<Health, String>),
    MemoryDetails(Result<MemoryDetails, String>),
    Usage(Result<UsageResponse, String>),
    Providers(Result<Vec<ProviderConfig>, String>),
    Quotas(Result<QuotaResponse, String>),
    AutoSwitch(Result<AutoSwitchState, String>),
    Pools(Vec<AccountPool>),
    OpenAiPool(Result<AccountPool, String>),
}

#[derive(Default)]
struct ViewState {
    online: bool,
    status: String,
    action_error: Option<String>,
    pid: u32,
    working_set: u64,
    private_commit: u64,
    system_memory: Option<SystemMemory>,
    details: Option<MemoryDetails>,
    configs: Vec<ProviderConfig>,
    quotas: Vec<QuotaReport>,
    usage: Vec<UsageProvider>,
    pools: Vec<AccountPool>,
    providers: Vec<ProviderView>,
    auto_switch_threshold: u32,
    active_codex_account_id: Option<String>,
}

struct App {
    rx: Receiver<Update>,
    state: ViewState,
    expanded: bool,
    scroll_offset: i32,
    expanded_providers: HashSet<String>,
    provider_hits: Vec<(RECT, String)>,
    account_pause_hits: Vec<(RECT, AccountControl)>,
    hot_account_control: Option<AccountControl>,
    pressed_account_control: Option<AccountControl>,
    account_mutation: Option<String>,
    pause_overrides: HashMap<String, bool>,
    show_usage_only: bool,
    usage_toggle_hit: Option<RECT>,
    width: i32,
    drag_origin: Option<(POINT, RECT)>,
    resize_origin: Option<(POINT, RECT, ResizeEdge)>,
    drag_moved: bool,
    pressed_button: Option<Button>,
    button_inside: bool,
    power_hot: bool,
    minimize_hot: bool,
    power_pending: bool,
    user_positioned: bool,
    force_refresh: Arc<AtomicBool>,
    want_details: Arc<AtomicBool>,
}

impl App {
    fn drain_updates(&mut self) {
        while let Ok(update) = self.rx.try_recv() {
            match update {
                Update::NativeMemory {
                    pid,
                    working_set,
                    private_commit,
                    system_memory,
                } => {
                    self.state.pid = pid;
                    self.state.working_set = working_set;
                    self.state.private_commit = private_commit;
                    if let Some(system_memory) = system_memory {
                        self.state.system_memory = Some(system_memory);
                    }
                }
                Update::Health(result) => match result {
                    Ok(health) => {
                        self.state.online = true;
                        self.state.action_error = None;
                        self.state.pid = health.pid;
                        self.state.status = "Connected".into();
                    }
                    Err(error) => {
                        self.state.online = false;
                        self.state.action_error = None;
                        self.state.pid = 0;
                        self.state.working_set = 0;
                        self.state.private_commit = 0;
                        self.state.status = error;
                    }
                },
                Update::MemoryDetails(result) => {
                    if let Ok(details) = result {
                        self.state.details = Some(details);
                    }
                }
                Update::Usage(result) => match result {
                    Ok(value) => self.state.usage = value.latest_day_providers(),
                    Err(error) => self.state.status = error,
                },
                Update::Providers(result) => match result {
                    Ok(value) => self.state.configs = value,
                    Err(error) => self.state.status = error,
                },
                Update::Quotas(result) => match result {
                    Ok(value) => self.state.quotas = value.reports,
                    Err(error) => self.state.status = error,
                },
                Update::AutoSwitch(result) => match result {
                    Ok(value) => {
                        self.state.auto_switch_threshold = value.auto_switch_threshold.min(100);
                        self.state.active_codex_account_id = value.active_codex_account_id;
                    }
                    Err(error) => self.state.status = error,
                },
                Update::Pools(value) => self.install_pools(value),
                Update::OpenAiPool(result) => match result {
                    Ok(pool) => self.install_pool(pool),
                    Err(error) => self.state.status = error,
                },
            }
        }
        mark_codex_active_account(
            &mut self.state.pools,
            self.state.active_codex_account_id.as_deref(),
        );
        self.state.providers = merge_providers(
            &self.state.configs,
            &self.state.quotas,
            &self.state.usage,
            &self.state.pools,
        );
    }

    fn apply_pause_overrides(&mut self, pool: &mut AccountPool) {
        if pool.provider != "openai" {
            return;
        }
        let mut confirmed = Vec::new();
        for account in &mut pool.accounts {
            if let Some(&desired) = self.pause_overrides.get(&account.id) {
                if account.paused == desired {
                    confirmed.push(account.id.clone());
                } else {
                    account.paused = desired;
                }
            }
        }
        for id in confirmed {
            self.pause_overrides.remove(&id);
        }
    }

    fn install_pool(&mut self, mut pool: AccountPool) {
        self.apply_pause_overrides(&mut pool);
        if let Some(existing) = self
            .state
            .pools
            .iter_mut()
            .find(|existing| existing.provider == pool.provider)
        {
            *existing = pool;
        } else {
            self.state.pools.push(pool);
        }
    }

    fn install_pools(&mut self, mut pools: Vec<AccountPool>) {
        for pool in &mut pools {
            self.apply_pause_overrides(pool);
        }
        self.state.pools = pools;
    }

    fn desired_height(&self) -> i32 {
        if !self.expanded {
            return COLLAPSED_HEIGHT;
        }
        let mut height = 114;
        for provider in self.visible_providers() {
            height += provider_height(provider);
            if self.expanded_providers.contains(&provider.name) {
                height += provider.accounts.iter().map(account_height).sum::<i32>();
            }
        }
        if self.usage_only_count() > 0 {
            height += USAGE_TOGGLE_HEIGHT;
        }
        height.clamp(180, 720)
    }

    fn content_height(&self) -> i32 {
        let mut height = 0;
        for provider in self.visible_providers() {
            height += provider_height(provider);
            if self.expanded_providers.contains(&provider.name) {
                height += provider.accounts.iter().map(account_height).sum::<i32>();
            }
        }
        if self.usage_only_count() > 0 {
            height += USAGE_TOGGLE_HEIGHT;
        }
        height
    }

    fn visible_providers(&self) -> impl Iterator<Item = &ProviderView> {
        self.state
            .providers
            .iter()
            .filter(|provider| provider_has_quota(provider) || self.show_usage_only)
    }

    fn usage_only_count(&self) -> usize {
        self.state
            .providers
            .iter()
            .filter(|provider| !provider_has_quota(provider))
            .count()
    }

    fn clamp_scroll(&mut self, window_height: i32) {
        let viewport = (window_height - 101).max(1);
        self.scroll_offset = self
            .scroll_offset
            .clamp(0, (self.content_height() - viewport).max(0));
    }
}

struct QuotaBarRow {
    label: String,
    percent: f64,
    reset_at: Option<f64>,
}

fn quota_rows(quota: Option<&Quota>) -> Vec<QuotaBarRow> {
    let Some(quota) = quota else {
        return Vec::new();
    };
    let mut rows = Vec::new();
    if let Some(percent) = quota.five_hour_percent {
        rows.push(QuotaBarRow {
            label: "5h limit".into(),
            percent,
            reset_at: quota.five_hour_reset_at,
        });
    }
    if let Some(percent) = quota.weekly_percent {
        rows.push(QuotaBarRow {
            label: "Weekly limit".into(),
            percent,
            reset_at: quota.weekly_reset_at,
        });
    }
    if let Some(percent) = quota.monthly_percent {
        rows.push(QuotaBarRow {
            label: "Monthly limit".into(),
            percent,
            reset_at: quota.monthly_reset_at,
        });
    }
    for window in &quota.custom_windows {
        if let Some(percent) = window.percent {
            rows.push(QuotaBarRow {
                label: window.label.clone(),
                percent,
                reset_at: window.reset_at,
            });
        }
    }
    rows
}

fn provider_has_quota(provider: &ProviderView) -> bool {
    !quota_rows(provider.quota.as_ref()).is_empty()
}

fn provider_height(provider: &ProviderView) -> i32 {
    let rows = quota_rows(provider.quota.as_ref()).len() as i32;
    if rows == 0 {
        48
    } else {
        38 + rows * 28
    }
}

fn account_height(account: &AccountView) -> i32 {
    let rows = quota_rows(account.quota.as_ref()).len() as i32;
    if rows == 0 {
        38
    } else {
        34 + rows * 26
    }
}

fn main() -> windows::core::Result<()> {
    unsafe {
        let _ = SetProcessDpiAwarenessContext(DPI_AWARENESS_CONTEXT_PER_MONITOR_AWARE_V2);
        if let Ok(existing) = FindWindowW(CLASS_NAME, PCWSTR::null()) {
            let _ = ShowWindow(existing, SW_SHOWNOACTIVATE);
            let _ = SetWindowPos(
                existing,
                HWND_TOPMOST,
                0,
                0,
                0,
                0,
                SWP_NOMOVE | SWP_NOSIZE | SWP_NOACTIVATE,
            );
            return Ok(());
        }
        let mut lucide_font_count = 0u32;
        let lucide_font_resource = AddFontMemResourceEx(
            LUCIDE_FONT_BYTES.as_ptr().cast(),
            LUCIDE_FONT_BYTES.len() as u32,
            None,
            &mut lucide_font_count,
        );
        if lucide_font_resource.is_invalid() || lucide_font_count == 0 {
            return Err(windows::core::Error::from_win32());
        }
        let instance = GetModuleHandleW(None)?;
        let cursor = LoadCursorW(None, IDC_ARROW)?;
        let class = WNDCLASSW {
            hCursor: cursor,
            hInstance: instance.into(),
            lpszClassName: CLASS_NAME,
            lpfnWndProc: Some(window_proc),
            style: CS_HREDRAW | CS_VREDRAW,
            ..Default::default()
        };
        if RegisterClassW(&class) == 0 {
            return Err(windows::core::Error::from_win32());
        }

        let hwnd = CreateWindowExW(
            WS_EX_TOPMOST | WS_EX_TOOLWINDOW | WS_EX_LAYERED,
            CLASS_NAME,
            w!("OCX Notch"),
            WS_POPUP,
            0,
            0,
            DEFAULT_WIDTH,
            COLLAPSED_HEIGHT,
            None,
            None,
            instance,
            None,
        )?;
        SetLayeredWindowAttributes(hwnd, COLORREF(0), 238, LWA_ALPHA)?;
        let saved_placement = load_window_placement();
        let initial_width = saved_placement
            .map(|placement| placement.width.clamp(MIN_WIDTH, MAX_WIDTH))
            .unwrap_or(DEFAULT_WIDTH);
        let (tx, rx) = mpsc::channel();
        let force_refresh = Arc::new(AtomicBool::new(true));
        let want_details = Arc::new(AtomicBool::new(false));
        APP.set(Mutex::new(App {
            rx,
            state: ViewState {
                status: "Loading OCX…".into(),
                auto_switch_threshold: 80,
                ..Default::default()
            },
            expanded: false,
            scroll_offset: 0,
            expanded_providers: HashSet::new(),
            provider_hits: Vec::new(),
            account_pause_hits: Vec::new(),
            hot_account_control: None,
            pressed_account_control: None,
            account_mutation: None,
            pause_overrides: HashMap::new(),
            show_usage_only: false,
            usage_toggle_hit: None,
            width: initial_width,
            drag_origin: None,
            resize_origin: None,
            drag_moved: false,
            pressed_button: None,
            button_inside: false,
            power_hot: false,
            minimize_hot: false,
            power_pending: false,
            user_positioned: saved_placement.is_some(),
            force_refresh: force_refresh.clone(),
            want_details: want_details.clone(),
        }))
        .ok();
        let restored_width = if let Some(placement) = saved_placement {
            restore_window_placement(hwnd, placement, COLLAPSED_HEIGHT)
        } else {
            position_window_on_cursor(hwnd, initial_width, COLLAPSED_HEIGHT);
            initial_width
        };
        with_app(|app| app.width = restored_width);
        apply_round_region(hwnd, restored_width, COLLAPSED_HEIGHT);
        let _ = ShowWindow(hwnd, SW_SHOWNOACTIVATE);
        start_workers(hwnd.0 as isize, tx, force_refresh, want_details);

        let mut message = MSG::default();
        while GetMessageW(&mut message, None, 0, 0).into() {
            let _ = TranslateMessage(&message);
            DispatchMessageW(&message);
        }
        let _ = RemoveFontMemResourceEx(lucide_font_resource);
    }
    Ok(())
}

fn start_workers(
    hwnd: isize,
    tx: Sender<Update>,
    force_refresh: Arc<AtomicBool>,
    want_details: Arc<AtomicBool>,
) {
    let pid = Arc::new(AtomicU32::new(0));
    let api_pid = pid.clone();
    let api_tx = tx.clone();
    thread::spawn(move || {
        let mut last_health = Instant::now() - Duration::from_secs(60);
        let mut last_usage = Instant::now() - Duration::from_secs(60);
        let mut last_openai_pool = Instant::now() - Duration::from_secs(60);
        let mut last_active = Instant::now() - Duration::from_secs(60);
        let mut last_slow = Instant::now() - Duration::from_secs(600);
        let mut last_details = Instant::now() - Duration::from_secs(60);
        loop {
            let forced = force_refresh.swap(false, Ordering::Relaxed);
            if forced || last_health.elapsed() >= Duration::from_secs(30) {
                let result = api::get_json::<Health>("/healthz", 8_000);
                api_pid.store(result.as_ref().map_or(0, |h| h.pid), Ordering::Relaxed);
                send_update(hwnd, &api_tx, Update::Health(result));
                last_health = Instant::now();
            }
            if forced || last_usage.elapsed() >= Duration::from_secs(30) {
                send_update(
                    hwnd,
                    &api_tx,
                    Update::Usage(api::get_json("/api/usage?range=7d", 20_000)),
                );
                last_usage = Instant::now();
            }
            if forced || last_openai_pool.elapsed() >= Duration::from_secs(5) {
                send_update(
                    hwnd,
                    &api_tx,
                    Update::OpenAiPool(api::fetch_codex_account_pool()),
                );
                last_openai_pool = Instant::now();
            }
            if forced || last_slow.elapsed() >= Duration::from_secs(300) {
                let configs = api::get_json::<Vec<ProviderConfig>>("/api/providers", 20_000);
                if let Ok(ref values) = configs {
                    let pools = values.iter().map(api::fetch_account_pool).collect();
                    send_update(hwnd, &api_tx, Update::Pools(pools));
                }
                send_update(hwnd, &api_tx, Update::Providers(configs));
                send_update(
                    hwnd,
                    &api_tx,
                    Update::Quotas(api::get_json("/api/provider-quotas", 30_000)),
                );
                last_slow = Instant::now();
            }
            if forced || last_active.elapsed() >= Duration::from_secs(5) {
                send_update(
                    hwnd,
                    &api_tx,
                    Update::AutoSwitch(api::get_json("/api/codex-auth/active", 3_000)),
                );
                last_active = Instant::now();
            }
            if want_details.load(Ordering::Relaxed)
                && (forced || last_details.elapsed() >= Duration::from_secs(45))
            {
                send_update(
                    hwnd,
                    &api_tx,
                    Update::MemoryDetails(api::get_json("/api/system/memory", 15_000)),
                );
                last_details = Instant::now();
            }
            thread::sleep(Duration::from_millis(500));
        }
    });

    thread::spawn(move || loop {
        let current_pid = pid.load(Ordering::Relaxed);
        if current_pid != 0 {
            if let Some((working_set, private_commit)) = sample_process(current_pid) {
                let system_memory = sample_system_memory();
                send_update(
                    hwnd,
                    &tx,
                    Update::NativeMemory {
                        pid: current_pid,
                        working_set,
                        private_commit,
                        system_memory,
                    },
                );
            }
        }
        thread::sleep(Duration::from_secs(2));
    });
}

fn send_update(hwnd: isize, tx: &Sender<Update>, update: Update) {
    if tx.send(update).is_ok() {
        unsafe {
            let _ = PostMessageW(HWND(hwnd as *mut _), WM_DATA, WPARAM(0), LPARAM(0));
        }
    }
}

fn launch_power_action(hwnd: HWND, action: &'static str) {
    let hwnd_value = hwnd.0 as isize;
    thread::spawn(move || {
        let result = api::run_ocx_command(action);
        if result.is_ok() {
            let deadline = Instant::now() + Duration::from_secs(15);
            loop {
                thread::sleep(Duration::from_millis(250));
                let health = api::get_json::<Health>("/healthz", 750);
                let reached_target = if action == "start" {
                    health.is_ok()
                } else {
                    health.is_err()
                };
                if reached_target {
                    with_app(|app| {
                        app.power_pending = false;
                        app.state.action_error = None;
                        if let Ok(health) = health {
                            app.state.online = true;
                            app.state.pid = health.pid;
                            app.state.status = "Connected".into();
                            app.force_refresh.store(true, Ordering::Relaxed);
                        } else {
                            app.state.online = false;
                            app.state.pid = 0;
                            app.state.working_set = 0;
                            app.state.private_commit = 0;
                            app.state.status = "OCX offline".into();
                        }
                    });
                    unsafe {
                        let _ =
                            PostMessageW(HWND(hwnd_value as *mut _), WM_DATA, WPARAM(0), LPARAM(0));
                    }
                    return;
                }
                if Instant::now() >= deadline {
                    break;
                }
            }
        }
        with_app(|app| {
            app.power_pending = false;
            match result {
                Ok(()) => {
                    app.state.action_error = None;
                    app.force_refresh.store(true, Ordering::Relaxed);
                }
                Err(error) => {
                    app.state.action_error = Some(error.clone());
                    app.state.status = error;
                }
            }
        });
        unsafe {
            let _ = PostMessageW(HWND(hwnd_value as *mut _), WM_DATA, WPARAM(0), LPARAM(0));
        }
    });
}

fn account_action_rect(width: i32, top: i32, identity_width: i32) -> RECT {
    let min_left = ACCOUNT_IDENTITY_LEFT + 58;
    let max_left = (width - 244 - ACCOUNT_ACTION_GAP - ACCOUNT_ACTION_WIDTH).max(min_left);
    let left = (ACCOUNT_IDENTITY_LEFT + identity_width.max(0) + ACCOUNT_ACTION_GAP)
        .min(max_left)
        .max(min_left);
    RECT {
        left,
        top,
        right: left + ACCOUNT_ACTION_WIDTH,
        bottom: top + ACCOUNT_ACTION_HEIGHT,
    }
}

fn set_openai_account_paused(pools: &mut [AccountPool], id: &str, paused: bool) -> bool {
    let Some(account) = pools
        .iter_mut()
        .find(|pool| pool.provider == "openai")
        .and_then(|pool| pool.accounts.iter_mut().find(|account| account.id == id))
    else {
        return false;
    };
    account.paused = paused;
    true
}

fn launch_pause_action(hwnd: HWND, id: String, paused: bool) {
    let mut started = false;
    with_app(|app| {
        if app.account_mutation.is_some() {
            return;
        }
        app.account_mutation = Some(id.clone());
        app.pause_overrides.insert(id.clone(), paused);
        set_openai_account_paused(&mut app.state.pools, &id, paused);
        app.state.status = if paused {
            "Pausing account…".into()
        } else {
            "Resuming account…".into()
        };
        started = true;
    });
    if !started {
        return;
    }
    unsafe {
        let _ = InvalidateRect(hwnd, None, false);
    }

    let hwnd_value = hwnd.0 as isize;
    thread::spawn(move || {
        let result = api::set_codex_account_paused(&id, paused);
        with_app(|app| {
            app.account_mutation = None;
            match result {
                Ok(()) => {
                    app.state.status = if paused {
                        "Account paused · excluded from pool".into()
                    } else {
                        "Account resumed · included in pool".into()
                    };
                    app.force_refresh.store(true, Ordering::Release);
                }
                Err(error) => {
                    app.pause_overrides.remove(&id);
                    set_openai_account_paused(&mut app.state.pools, &id, !paused);
                    app.state.status = error;
                }
            }
        });
        unsafe {
            let _ = PostMessageW(HWND(hwnd_value as *mut _), WM_DATA, WPARAM(0), LPARAM(0));
        }
    });
}

fn sample_process(pid: u32) -> Option<(u64, u64)> {
    unsafe {
        let process = OpenProcess(PROCESS_QUERY_INFORMATION | PROCESS_VM_READ, false, pid).ok()?;
        let mut counters = PROCESS_MEMORY_COUNTERS_EX::default();
        counters.cb = size_of::<PROCESS_MEMORY_COUNTERS_EX>() as u32;
        let ok = K32GetProcessMemoryInfo(
            process,
            (&mut counters as *mut PROCESS_MEMORY_COUNTERS_EX).cast(),
            counters.cb,
        )
        .as_bool();
        let _ = CloseHandle(process);
        ok.then_some((counters.WorkingSetSize as u64, counters.PrivateUsage as u64))
    }
}

fn sample_system_memory() -> Option<SystemMemory> {
    unsafe {
        let mut performance = PERFORMANCE_INFORMATION::default();
        performance.cb = size_of::<PERFORMANCE_INFORMATION>() as u32;
        GetPerformanceInfo(&mut performance, performance.cb).ok()?;
        let page_size = performance.PageSize as u64;
        if page_size == 0 {
            return None;
        }
        Some(SystemMemory {
            physical_total: (performance.PhysicalTotal as u64).saturating_mul(page_size),
            physical_available: (performance.PhysicalAvailable as u64).saturating_mul(page_size),
            commit_total: (performance.CommitTotal as u64).saturating_mul(page_size),
            commit_limit: (performance.CommitLimit as u64).saturating_mul(page_size),
        })
    }
}

fn pressure_info(memory: Option<SystemMemory>) -> Option<(PressureLevel, u64)> {
    let memory = memory?;
    if memory.physical_total == 0 || memory.commit_limit == 0 {
        return None;
    }

    let physical_headroom = memory.physical_available.min(memory.physical_total);
    let commit_headroom = memory.commit_limit.saturating_sub(memory.commit_total);
    let caution_physical = (memory.physical_total / 10).max(2 * GIB);
    let caution_commit = (memory.commit_limit / 10).max(2 * GIB);
    let danger_physical = (memory.physical_total / 20).max(GIB);
    let danger_commit = (memory.commit_limit / 20).max(GIB);
    let danger = physical_headroom < danger_physical || commit_headroom < danger_commit;
    let caution = physical_headroom < caution_physical || commit_headroom < caution_commit;
    let level = if danger {
        PressureLevel::Danger
    } else if caution {
        PressureLevel::Caution
    } else {
        PressureLevel::Stable
    };
    Some((level, physical_headroom.min(commit_headroom)))
}

fn pressure_label(level: PressureLevel) -> &'static str {
    match level {
        PressureLevel::Stable => "안정",
        PressureLevel::Caution => "주의",
        PressureLevel::Danger => "위험",
    }
}

fn pressure_color(level: PressureLevel) -> u32 {
    match level {
        PressureLevel::Stable => 0x006ee7a8,
        PressureLevel::Caution => 0x0024bffb,
        PressureLevel::Danger => 0x005454f5,
    }
}

fn header_chart_rect(width: i32, expanded: bool, top: i32, bottom: i32) -> RECT {
    let controls_gap = if expanded { 82 } else { 50 };
    RECT {
        left: HEADER_CHART_LEFT,
        top,
        right: (width - controls_gap).max(HEADER_CHART_LEFT + 1),
        bottom,
    }
}

unsafe fn draw_capacity_gauge(dc: HDC, rect: RECT, current: u64, max: u64, color: u32) {
    let width = rect.right - rect.left;
    let height = rect.bottom - rect.top;
    if width <= 0 || height <= 0 || max == 0 {
        return;
    }

    let step = 4;
    let tick_count = ((width - 1) / step + 1).max(1);
    let ratio = (current as f64 / max as f64).clamp(0.0, 1.0);
    let filled = if current == 0 {
        0
    } else {
        ((tick_count as f64 * ratio).ceil() as i32).clamp(1, tick_count)
    };
    let filled_pen = CreatePen(PS_SOLID, 1, COLORREF(color));
    let empty_pen = CreatePen(PS_SOLID, 1, COLORREF(0x00423a35));
    let old_pen = SelectObject(dc, empty_pen);
    for index in 0..tick_count {
        let pen = if index < filled {
            filled_pen
        } else {
            empty_pen
        };
        let _ = SelectObject(dc, pen);
        let x = rect.left + index * step;
        let _ = MoveToEx(dc, x, rect.top, None);
        let _ = LineTo(dc, x, rect.bottom);
    }
    let _ = SelectObject(dc, old_pen);
    let _ = DeleteObject(filled_pen);
    let _ = DeleteObject(empty_pen);
}

unsafe extern "system" fn window_proc(
    hwnd: HWND,
    message: u32,
    wparam: WPARAM,
    lparam: LPARAM,
) -> LRESULT {
    match message {
        WM_DATA => {
            with_app(|app| app.drain_updates());
            resize_for_state(hwnd);
            let _ = InvalidateRect(hwnd, None, false);
            LRESULT(0)
        }
        WM_PAINT => {
            paint(hwnd);
            LRESULT(0)
        }
        WM_SETCURSOR => {
            let mut point = POINT::default();
            let mut rect = RECT::default();
            let _ = GetCursorPos(&mut point);
            let _ = ScreenToClient(hwnd, &mut point);
            let _ = GetClientRect(hwnd, &mut rect);
            if point.x >= 0 && point.x < rect.right && point.y >= 0 && point.y < rect.bottom {
                let cursor_id = if point.x < RESIZE_EDGE || point.x >= rect.right - RESIZE_EDGE {
                    IDC_SIZEWE
                } else {
                    IDC_ARROW
                };
                if let Ok(cursor) = LoadCursorW(None, cursor_id) {
                    let _ = SetCursor(cursor);
                    return LRESULT(1);
                }
            }
            DefWindowProcW(hwnd, message, wparam, lparam)
        }
        WM_LBUTTONDOWN => {
            let x = (lparam.0 as i16) as i32;
            let y = ((lparam.0 >> 16) as i16) as i32;
            let mut cursor = POINT::default();
            let mut window = RECT::default();
            let _ = GetCursorPos(&mut cursor);
            let _ = GetWindowRect(hwnd, &mut window);
            let mut button_down = false;
            with_app(|app| {
                app.power_hot = point_in(&power_hit_rect(app.width), x, y);
                app.minimize_hot = app.expanded && point_in(&minimize_hit_rect(app.width), x, y);
                let account_control = app
                    .account_pause_hits
                    .iter()
                    .find(|(rect, _)| point_in(rect, x, y))
                    .map(|(_, control)| control.clone());
                let resize_edge = if x < RESIZE_EDGE {
                    Some(ResizeEdge::Left)
                } else if x >= app.width - RESIZE_EDGE {
                    Some(ResizeEdge::Right)
                } else {
                    None
                };
                if let Some(edge) = resize_edge {
                    app.resize_origin = Some((cursor, window, edge));
                    app.pressed_button = None;
                    app.button_inside = false;
                    app.drag_origin = None;
                    app.drag_moved = false;
                    app.pressed_account_control = None;
                } else if let Some(control) = account_control {
                    app.resize_origin = None;
                    app.pressed_button = None;
                    app.pressed_account_control = Some(control);
                    app.button_inside = false;
                    app.drag_origin = None;
                    app.drag_moved = false;
                    button_down = true;
                } else if app.power_hot {
                    app.pressed_button = Some(Button::Power);
                    app.button_inside = true;
                    app.drag_origin = None;
                    app.drag_moved = false;
                    app.pressed_account_control = None;
                    button_down = true;
                } else if app.minimize_hot {
                    app.pressed_button = Some(Button::Minimize);
                    app.button_inside = true;
                    app.drag_origin = None;
                    app.drag_moved = false;
                    app.pressed_account_control = None;
                    button_down = true;
                } else {
                    app.resize_origin = None;
                    app.pressed_button = None;
                    app.button_inside = false;
                    app.drag_origin = Some((cursor, window));
                    app.drag_moved = false;
                    app.pressed_account_control = None;
                }
            });
            let _ = SetCapture(hwnd);
            if button_down {
                let _ = InvalidateRect(hwnd, None, false);
            }
            LRESULT(0)
        }
        WM_MOUSEMOVE => {
            let x = (lparam.0 as i16) as i32;
            let y = ((lparam.0 >> 16) as i16) as i32;
            let mut cursor = POINT::default();
            let _ = GetCursorPos(&mut cursor);
            let mut target = None;
            let mut resize_target = None;
            let mut changed = false;
            with_app(|app| {
                let power_hot = point_in(&power_hit_rect(app.width), x, y);
                let minimize_hot = app.expanded && point_in(&minimize_hit_rect(app.width), x, y);
                let hot_account_control = app
                    .account_pause_hits
                    .iter()
                    .find(|(rect, _)| point_in(rect, x, y))
                    .map(|(_, control)| control.clone());
                if app.power_hot != power_hot
                    || app.minimize_hot != minimize_hot
                    || app.hot_account_control != hot_account_control
                {
                    changed = true;
                }
                app.power_hot = power_hot;
                app.minimize_hot = minimize_hot;
                app.hot_account_control = hot_account_control;
                if let Some(button) = app.pressed_button {
                    let inside = match button {
                        Button::Power => power_hot,
                        Button::Minimize => minimize_hot,
                    };
                    if app.button_inside != inside {
                        changed = true;
                    }
                    app.button_inside = inside;
                } else if app.pressed_account_control.is_some() {
                    // Account controls never initiate a window drag.
                } else if let Some((origin, window, edge)) = app.resize_origin {
                    let dx = cursor.x - origin.x;
                    let original_width = window.right - window.left;
                    let width = match edge {
                        ResizeEdge::Left => original_width - dx,
                        ResizeEdge::Right => original_width + dx,
                    }
                    .clamp(MIN_WIDTH, MAX_WIDTH);
                    let left = match edge {
                        ResizeEdge::Left => window.right - width,
                        ResizeEdge::Right => window.left,
                    };
                    app.width = width;
                    app.drag_moved = true;
                    app.user_positioned = true;
                    resize_target = Some((left, window.top, width, window.bottom - window.top));
                } else if let Some((origin, window)) = app.drag_origin {
                    let dx = cursor.x - origin.x;
                    let dy = cursor.y - origin.y;
                    if app.drag_moved || dx.abs() >= 4 || dy.abs() >= 4 {
                        app.drag_moved = true;
                        app.user_positioned = true;
                        target = Some((window.left + dx, window.top + dy));
                    }
                }
            });
            if let Some((x, y)) = target {
                let _ = SetWindowPos(hwnd, HWND_TOPMOST, x, y, 0, 0, SWP_NOSIZE | SWP_NOACTIVATE);
            }
            if let Some((x, y, width, height)) = resize_target {
                let _ = SetWindowPos(hwnd, HWND_TOPMOST, x, y, width, height, SWP_NOACTIVATE);
                apply_round_region(hwnd, width, height);
            }
            if changed {
                let _ = InvalidateRect(hwnd, None, false);
            }
            LRESULT(0)
        }
        WM_LBUTTONUP => {
            let x = (lparam.0 as i16) as i32;
            let y = ((lparam.0 >> 16) as i16) as i32;
            let mut changed = false;
            let mut was_drag = false;
            let mut handled_button = false;
            let mut power_action = None;
            let mut pause_action = None;
            with_app(|app| {
                was_drag = app.drag_moved;
                let pressed_button = app.pressed_button.take();
                let pressed_account_control = app.pressed_account_control.take();
                let button_inside = app.button_inside;
                app.button_inside = false;
                app.drag_origin = None;
                app.resize_origin = None;
                app.drag_moved = false;
                if let Some(control) = pressed_account_control {
                    handled_button = true;
                    changed = true;
                    let released_inside = app
                        .account_pause_hits
                        .iter()
                        .any(|(rect, hit)| hit.id == control.id && point_in(rect, x, y));
                    if released_inside && app.account_mutation.is_none() {
                        pause_action = Some((control.id, !control.paused));
                    }
                    return;
                }
                if let Some(button) = pressed_button {
                    handled_button = true;
                    changed = true;
                    if button_inside {
                        match button {
                            Button::Power if !app.power_pending => {
                                let action = if app.state.online { "stop" } else { "start" };
                                app.power_pending = true;
                                app.state.status = if action == "stop" {
                                    "Stopping OCX...".into()
                                } else {
                                    "Starting OCX...".into()
                                };
                                power_action = Some(action);
                            }
                            Button::Minimize if app.expanded => {
                                app.expanded = false;
                                app.scroll_offset = 0;
                                app.want_details.store(false, Ordering::Relaxed);
                            }
                            _ => {}
                        }
                    }
                    return;
                }
                if was_drag {
                    return;
                }
                if !app.expanded {
                    app.expanded = true;
                    app.want_details.store(true, Ordering::Relaxed);
                    changed = true;
                } else if app
                    .usage_toggle_hit
                    .as_ref()
                    .is_some_and(|rect| point_in(rect, x, y))
                {
                    app.show_usage_only = !app.show_usage_only;
                    changed = true;
                } else if let Some((_, name)) = app
                    .provider_hits
                    .iter()
                    .find(|(rect, _)| point_in(rect, x, y))
                {
                    let name = name.clone();
                    if !app.expanded_providers.remove(&name) {
                        app.expanded_providers.insert(name);
                    }
                    changed = true;
                }
            });
            let _ = ReleaseCapture();
            if was_drag {
                save_window_placement(hwnd);
            }
            if let Some(action) = power_action {
                launch_power_action(hwnd, action);
            }
            if let Some((id, paused)) = pause_action {
                launch_pause_action(hwnd, id, paused);
            }
            if handled_button {
                if changed {
                    resize_for_state(hwnd);
                    let _ = InvalidateRect(hwnd, None, false);
                }
                return LRESULT(0);
            }
            if was_drag {
                return LRESULT(0);
            }
            if changed {
                resize_for_state(hwnd);
                let _ = InvalidateRect(hwnd, None, false);
            }
            LRESULT(0)
        }
        WM_CAPTURECHANGED => {
            with_app(|app| {
                app.drag_origin = None;
                app.resize_origin = None;
                app.drag_moved = false;
                app.pressed_button = None;
                app.pressed_account_control = None;
                app.button_inside = false;
            });
            LRESULT(0)
        }
        WM_MOUSEWHEEL => {
            let delta = ((wparam.0 >> 16) as i16) as i32;
            with_app(|app| {
                if app.expanded {
                    app.scroll_offset -= delta.signum() * 76;
                    app.clamp_scroll(app.desired_height());
                }
            });
            let _ = InvalidateRect(hwnd, None, false);
            LRESULT(0)
        }
        WM_RBUTTONUP => {
            show_context_menu(hwnd);
            LRESULT(0)
        }
        WM_COMMAND => {
            let command = wparam.0 & 0xffff;
            let mut requested_threshold = None;
            if (MENU_THRESHOLD_BASE..=MENU_THRESHOLD_BASE + 100).contains(&command) {
                requested_threshold = Some((command - MENU_THRESHOLD_BASE) as u32);
            } else if command == MENU_THRESHOLD_DOWN || command == MENU_THRESHOLD_UP {
                with_app(|app| {
                    requested_threshold = Some(if command == MENU_THRESHOLD_DOWN {
                        app.state.auto_switch_threshold.saturating_sub(1)
                    } else {
                        (app.state.auto_switch_threshold + 1).min(100)
                    });
                });
            }
            if let Some(threshold) = requested_threshold {
                with_app(|app| {
                    app.state.auto_switch_threshold = threshold;
                    app.state.status = if threshold == 0 {
                        "Account rotation disabled".into()
                    } else {
                        format!("Account rotation at {threshold}%")
                    };
                });
                let hwnd_value = hwnd.0 as isize;
                thread::spawn(move || {
                    let result = api::set_auto_switch_threshold(threshold);
                    with_app(|app| {
                        if let Err(error) = result {
                            app.state.status = error;
                        } else {
                            app.force_refresh.store(true, Ordering::Relaxed);
                        }
                    });
                    unsafe {
                        let _ =
                            PostMessageW(HWND(hwnd_value as *mut _), WM_DATA, WPARAM(0), LPARAM(0));
                    }
                });
            } else {
                match command {
                    MENU_REFRESH => {
                        with_app(|app| app.force_refresh.store(true, Ordering::Relaxed))
                    }
                    MENU_EXIT => {
                        let _ = DestroyWindow(hwnd);
                    }
                    _ => {}
                }
            }
            LRESULT(0)
        }
        WM_KEYDOWN if wparam.0 as u32 == 0x1b => {
            with_app(|app| {
                app.expanded = false;
                app.scroll_offset = 0;
                app.want_details.store(false, Ordering::Relaxed);
            });
            resize_for_state(hwnd);
            let _ = InvalidateRect(hwnd, None, false);
            LRESULT(0)
        }
        WM_DISPLAYCHANGE => {
            resize_for_state(hwnd);
            LRESULT(0)
        }
        WM_DESTROY => {
            PostQuitMessage(0);
            LRESULT(0)
        }
        _ => DefWindowProcW(hwnd, message, wparam, lparam),
    }
}

fn with_app(f: impl FnOnce(&mut App)) {
    if let Some(app) = APP.get() {
        if let Ok(mut app) = app.lock() {
            f(&mut app);
        }
    }
}

unsafe fn paint(hwnd: HWND) {
    let mut paint = PAINTSTRUCT::default();
    let dc = BeginPaint(hwnd, &mut paint);
    let mut client = RECT::default();
    let _ = GetClientRect(hwnd, &mut client);
    let width = client.right;
    let height = client.bottom;
    let memory_dc = CreateCompatibleDC(dc);
    let bitmap = CreateCompatibleBitmap(dc, width, height);
    let old_bitmap = SelectObject(memory_dc, bitmap);
    let background = CreateSolidBrush(COLORREF(0x00211b18));
    let _ = FillRect(memory_dc, &client, background);
    let _ = DeleteObject(background);
    let _ = SetBkMode(memory_dc, TRANSPARENT);

    with_app(|app| draw_app(memory_dc, width, height, app));
    let _ = BitBlt(dc, 0, 0, width, height, memory_dc, 0, 0, SRCCOPY);
    let _ = SelectObject(memory_dc, old_bitmap);
    let _ = DeleteObject(bitmap);
    let _ = DeleteDC(memory_dc);
    let _ = EndPaint(hwnd, &paint);
}

unsafe fn draw_app(dc: HDC, width: i32, height: i32, app: &mut App) {
    app.provider_hits.clear();
    app.account_pause_hits.clear();
    app.usage_toggle_hit = None;
    let body_font = make_font(14, 500);
    let small_font = make_font(12, 400);
    let old_font = SelectObject(dc, body_font);
    fill_solid(
        dc,
        RECT {
            left: 2,
            top: 22,
            right: 4,
            bottom: 36,
        },
        0x00423a35,
    );
    fill_solid(
        dc,
        RECT {
            left: width - 4,
            top: 22,
            right: width - 2,
            bottom: 36,
        },
        0x00423a35,
    );
    draw_power_control(dc, width, app);
    if app.expanded {
        draw_minimize_control(dc, width, app);
    }

    let private_text = if app.state.online && app.state.private_commit > 0 {
        format!("Private {}", format_bytes(app.state.private_commit))
    } else {
        "Private —".into()
    };
    let private_color = if app.state.online {
        0x006ee7a8
    } else {
        0x006f7380
    };
    let working_set_color = 0x009a9fa8;
    let _ = SelectObject(dc, body_font);
    set_text_color(dc, private_color);
    draw_text(
        dc,
        &private_text,
        RECT {
            left: 18,
            top: 6,
            right: HEADER_TEXT_RIGHT,
            bottom: 31,
        },
        DT_LEFT | DT_SINGLELINE | DT_VCENTER | DT_END_ELLIPSIS,
    );
    let ws = if app.state.working_set > 0 {
        format!("WS {}", format_bytes(app.state.working_set))
    } else if let Some(error) = &app.state.action_error {
        format!("WS {error}")
    } else {
        format!("WS {}", app.state.status)
    };
    let _ = SelectObject(dc, body_font);
    set_text_color(dc, working_set_color);
    draw_text(
        dc,
        &ws,
        RECT {
            left: 18,
            top: 29,
            right: HEADER_TEXT_RIGHT,
            bottom: 51,
        },
        DT_LEFT | DT_SINGLELINE | DT_VCENTER | DT_END_ELLIPSIS,
    );

    let mut private_gauge = header_chart_rect(width, app.expanded, 11, 25);
    let mut working_set_gauge = header_chart_rect(width, app.expanded, 35, 49);
    if let Some(memory) = app.state.system_memory {
        let commit_headroom = memory.commit_limit.saturating_sub(memory.commit_total);
        let private_max = app.state.private_commit.saturating_add(commit_headroom);
        let working_set_max = app
            .state
            .working_set
            .saturating_add(memory.physical_available);
        let available = private_gauge.right - private_gauge.left;
        let show_max = available >= 190;
        let pressure = pressure_info(Some(memory));
        let show_pressure = available >= 330 && pressure.is_some();

        if show_max {
            private_gauge.right -= HEADER_LABEL_WIDTH + HEADER_LABEL_GAP;
            working_set_gauge.right -= HEADER_LABEL_WIDTH + HEADER_LABEL_GAP;
        }
        if show_pressure {
            working_set_gauge.right -= HEADER_LABEL_WIDTH + HEADER_LABEL_GAP;
        }

        draw_capacity_gauge(
            dc,
            private_gauge,
            app.state.private_commit,
            private_max,
            private_color,
        );
        draw_capacity_gauge(
            dc,
            working_set_gauge,
            app.state.working_set,
            working_set_max,
            working_set_color,
        );

        if show_max {
            let _ = SelectObject(dc, small_font);
            set_text_color(dc, 0x008b8f98);
            draw_text(
                dc,
                &format!("Max {}", format_bytes(private_max)),
                RECT {
                    left: private_gauge.right + HEADER_LABEL_GAP,
                    top: 6,
                    right: private_gauge.right + HEADER_LABEL_GAP + HEADER_LABEL_WIDTH,
                    bottom: 30,
                },
                DT_RIGHT | DT_SINGLELINE | DT_VCENTER | DT_END_ELLIPSIS,
            );
            let ws_max_left = if show_pressure {
                working_set_gauge.right + HEADER_LABEL_GAP + HEADER_LABEL_WIDTH + HEADER_LABEL_GAP
            } else {
                working_set_gauge.right + HEADER_LABEL_GAP
            };
            draw_text(
                dc,
                &format!("Max {}", format_bytes(working_set_max)),
                RECT {
                    left: ws_max_left,
                    top: 30,
                    right: ws_max_left + HEADER_LABEL_WIDTH,
                    bottom: 52,
                },
                DT_RIGHT | DT_SINGLELINE | DT_VCENTER | DT_END_ELLIPSIS,
            );
        }
        if let Some((level, headroom)) = pressure.filter(|_| show_pressure) {
            set_text_color(dc, pressure_color(level));
            draw_text(
                dc,
                &format!("{} {}", pressure_label(level), format_bytes(headroom)),
                RECT {
                    left: working_set_gauge.right + HEADER_LABEL_GAP,
                    top: 30,
                    right: working_set_gauge.right + HEADER_LABEL_GAP + HEADER_LABEL_WIDTH,
                    bottom: 52,
                },
                DT_RIGHT | DT_SINGLELINE | DT_VCENTER | DT_END_ELLIPSIS,
            );
        }
    }

    if app.expanded {
        let divider = CreateSolidBrush(COLORREF(0x003a322d));
        let _ = FillRect(
            dc,
            &RECT {
                left: 16,
                top: 57,
                right: width - 16,
                bottom: 58,
            },
            divider,
        );
        let _ = DeleteObject(divider);
        let detail = app.state.details.as_ref();
        let detail_text = format!(
            "PID {}   ·   Private {}   ·   Working set {}{}   ·   Rotate {}",
            app.state.pid,
            if app.state.private_commit > 0 {
                format_bytes(app.state.private_commit)
            } else {
                "—".into()
            },
            if app.state.working_set > 0 {
                format_bytes(app.state.working_set)
            } else {
                "—".into()
            },
            detail
                .and_then(|d| d.heap_used)
                .map(|v| format!("   ·   Heap {}", format_bytes(v)))
                .unwrap_or_default(),
            if app.state.auto_switch_threshold == 0 {
                "off".into()
            } else {
                format!("{}%", app.state.auto_switch_threshold)
            },
        );
        let _ = SelectObject(dc, small_font);
        set_text_color(dc, 0x009da3ad);
        draw_text(
            dc,
            &detail_text,
            RECT {
                left: 18,
                top: 64,
                right: width - 18,
                bottom: 96,
            },
            DT_LEFT | DT_SINGLELINE | DT_VCENTER | DT_END_ELLIPSIS,
        );
        let mut y = 101 - app.scroll_offset;
        let _ = IntersectClipRect(dc, 0, 101, width, height);
        let usage_only_count = app.usage_only_count();
        let mut providers = app.state.providers.clone();
        providers.sort_by_key(|provider| !provider_has_quota(provider));
        providers.retain(|provider| provider_has_quota(provider) || app.show_usage_only);
        for provider in providers {
            let provider_height = provider_height(&provider);
            let row = RECT {
                left: 10,
                top: y,
                right: width - 10,
                bottom: y + provider_height,
            };
            if row.bottom > 101 && row.top < height {
                app.provider_hits.push((row, provider.name.clone()));
            }
            let _ = SelectObject(dc, body_font);
            set_text_color(dc, 0x00f0ece8);
            let marker = if provider.accounts.len() > 1 {
                if app.expanded_providers.contains(&provider.name) {
                    "▾"
                } else {
                    "▸"
                }
            } else {
                " "
            };
            draw_text(
                dc,
                &format!("{marker} {}", provider.label),
                RECT {
                    left: 18,
                    top: y,
                    right: width - 170,
                    bottom: y + 31,
                },
                DT_LEFT | DT_SINGLELINE | DT_VCENTER | DT_END_ELLIPSIS,
            );
            let _ = SelectObject(dc, small_font);
            set_text_color(dc, 0x008edbc0);
            draw_text(
                dc,
                &format!("오늘 {} 토큰", format_tokens(provider.tokens)),
                RECT {
                    left: width - 166,
                    top: y,
                    right: width - 18,
                    bottom: y + 31,
                },
                DT_RIGHT | DT_SINGLELINE | DT_VCENTER | DT_END_ELLIPSIS,
            );
            let rows = quota_rows(provider.quota.as_ref());
            if rows.is_empty() {
                set_text_color(dc, 0x008e949e);
                draw_text(
                    dc,
                    "사용량만 표시 · 할당량 없음",
                    RECT {
                        left: 38,
                        top: y + 26,
                        right: width - 18,
                        bottom: y + 47,
                    },
                    DT_LEFT | DT_SINGLELINE | DT_VCENTER | DT_END_ELLIPSIS,
                );
            } else {
                let mut quota_y = y + 31;
                for quota in &rows {
                    draw_quota_row(
                        dc,
                        quota,
                        38,
                        width - 18,
                        quota_y,
                        small_font,
                        app.state.auto_switch_threshold,
                    );
                    quota_y += 28;
                }
            }
            y += provider_height;
            if app.expanded_providers.contains(&provider.name) {
                let show_pause_control = provider.name == "openai";
                for account in provider.accounts {
                    let account_height = account_height(&account);
                    let identity_width = measure_text_width(dc, &account.identity);
                    let action_rect = account_action_rect(width, y, identity_width);
                    let busy = app.account_mutation.as_deref() == Some(account.id.as_str());
                    set_text_color(dc, 0x00c7cbd2);
                    draw_text(
                        dc,
                        &account.identity,
                        RECT {
                            left: ACCOUNT_IDENTITY_LEFT,
                            top: y,
                            right: if show_pause_control {
                                action_rect.left - ACCOUNT_ACTION_GAP
                            } else {
                                width - 250
                            },
                            bottom: y + 30,
                        },
                        DT_LEFT | DT_SINGLELINE | DT_VCENTER | DT_END_ELLIPSIS,
                    );
                    if show_pause_control {
                        let control = AccountControl {
                            id: account.id.clone(),
                            paused: account.paused,
                        };
                        let hot = !busy && app.hot_account_control.as_ref() == Some(&control);
                        let pressed = app.pressed_account_control.as_ref() == Some(&control);
                        draw_account_pause_control(
                            dc,
                            action_rect,
                            account.paused,
                            hot,
                            pressed,
                            busy,
                        );
                        if !busy && action_rect.bottom > 101 && action_rect.top < height {
                            app.account_pause_hits.push((action_rect, control));
                        }
                    }
                    set_text_color(
                        dc,
                        if account.paused {
                            0x008e949e
                        } else if account.active {
                            0x006ee7a8
                        } else {
                            0x008e949e
                        },
                    );
                    let suffix = if account.paused {
                        " · paused"
                    } else if account.active {
                        " · active"
                    } else {
                        ""
                    };
                    draw_text(
                        dc,
                        &format!("{}{}", account.health, suffix),
                        RECT {
                            left: width - 244,
                            top: y,
                            right: width - 18,
                            bottom: y + 30,
                        },
                        DT_RIGHT | DT_SINGLELINE | DT_VCENTER | DT_END_ELLIPSIS,
                    );
                    let rows = quota_rows(account.quota.as_ref());
                    let mut quota_y = y + 29;
                    for quota in &rows {
                        draw_quota_row(
                            dc,
                            quota,
                            58,
                            width - 18,
                            quota_y,
                            small_font,
                            app.state.auto_switch_threshold,
                        );
                        quota_y += 26;
                    }
                    y += account_height;
                }
            }
        }
        if usage_only_count > 0 {
            let toggle = RECT {
                left: 10,
                top: y,
                right: width - 10,
                bottom: y + USAGE_TOGGLE_HEIGHT,
            };
            if toggle.bottom > 101 && toggle.top < height {
                app.usage_toggle_hit = Some(toggle);
            }
            let _ = SelectObject(dc, small_font);
            set_text_color(dc, 0x00a6a6a6);
            draw_text(
                dc,
                &if app.show_usage_only {
                    format!("▾ 사용량만 있는 프로바이더 {usage_only_count}개 접기")
                } else {
                    format!("▸ 사용량만 있는 프로바이더 {usage_only_count}개 보기")
                },
                RECT {
                    left: 18,
                    top: y,
                    right: width - 18,
                    bottom: y + USAGE_TOGGLE_HEIGHT,
                },
                DT_LEFT | DT_SINGLELINE | DT_VCENTER | DT_END_ELLIPSIS,
            );
        }
        let _ = SelectClipRgn(dc, None);
    }
    let _ = SelectObject(dc, old_font);
    let _ = DeleteObject(body_font);
    let _ = DeleteObject(small_font);
}

unsafe fn draw_power_control(dc: HDC, width: i32, app: &App) {
    let pressed = app.pressed_button == Some(Button::Power) && app.button_inside;
    let mut color = if app.power_pending {
        0x0024bffb
    } else if app.state.online {
        0x006ee7a8
    } else {
        0x009a9fa8
    };
    if pressed || app.power_hot {
        color = 0x00e9f4ef;
    }
    draw_lucide_icon(dc, "\u{e140}", power_control_rect(width), color);
}

unsafe fn draw_minimize_control(dc: HDC, width: i32, app: &App) {
    let pressed = app.pressed_button == Some(Button::Minimize) && app.button_inside;
    let color = if pressed || app.minimize_hot {
        0x00d3d8df
    } else {
        0x007d817f
    };
    draw_lucide_icon(dc, "\u{e11c}", minimize_control_rect(width), color);
}

unsafe fn draw_account_pause_control(
    dc: HDC,
    rect: RECT,
    paused: bool,
    hot: bool,
    pressed: bool,
    busy: bool,
) {
    let color = if busy {
        0x006f7380
    } else if hot || pressed {
        0x00e9f4ef
    } else if paused {
        0x0024bffb
    } else {
        0x009a9fa8
    };
    let cx = (rect.left + rect.right) / 2;
    let cy = (rect.top + rect.bottom) / 2;
    if paused {
        // Play means include this account in the rotation pool again.
        for step in 0..7 {
            let half = 6 - step;
            fill_solid(
                dc,
                RECT {
                    left: cx - 4 + step,
                    top: cy - half,
                    right: cx - 2 + step,
                    bottom: cy + half,
                },
                color,
            );
        }
    } else {
        // Pause means exclude this account from the rotation pool.
        fill_solid(
            dc,
            RECT {
                left: cx - 5,
                top: cy - 6,
                right: cx - 2,
                bottom: cy + 6,
            },
            color,
        );
        fill_solid(
            dc,
            RECT {
                left: cx + 2,
                top: cy - 6,
                right: cx + 5,
                bottom: cy + 6,
            },
            color,
        );
    }
}

unsafe fn draw_lucide_icon(dc: HDC, glyph: &str, rect: RECT, color: u32) {
    let font = CreateFontW(
        -22,
        0,
        0,
        0,
        FW_NORMAL.0 as i32,
        0,
        0,
        0,
        DEFAULT_CHARSET.0 as u32,
        OUT_DEFAULT_PRECIS.0 as u32,
        CLIP_DEFAULT_PRECIS.0 as u32,
        ANTIALIASED_QUALITY.0 as u32,
        DEFAULT_PITCH.0 as u32,
        w!("lucide"),
    );
    let old_font = SelectObject(dc, font);
    set_text_color(dc, color);
    draw_text(
        dc,
        glyph,
        rect,
        DT_CENTER | DT_SINGLELINE | DT_VCENTER | DT_NOPREFIX,
    );
    let _ = SelectObject(dc, old_font);
    let _ = DeleteObject(font);
}

unsafe fn make_font(size: i32, weight: i32) -> HFONT {
    CreateFontW(
        -size,
        0,
        0,
        0,
        weight,
        0,
        0,
        0,
        DEFAULT_CHARSET.0 as u32,
        OUT_DEFAULT_PRECIS.0 as u32,
        CLIP_DEFAULT_PRECIS.0 as u32,
        CLEARTYPE_QUALITY.0 as u32,
        DEFAULT_PITCH.0 as u32,
        w!("Segoe UI"),
    )
}

unsafe fn set_text_color(dc: HDC, color: u32) {
    let _ = SetTextColor(dc, COLORREF(color));
}

unsafe fn draw_text(dc: HDC, text: &str, mut rect: RECT, format: DRAW_TEXT_FORMAT) {
    let mut wide: Vec<u16> = text.encode_utf16().collect();
    let _ = DrawTextW(dc, &mut wide, &mut rect, format);
}

unsafe fn measure_text_width(dc: HDC, text: &str) -> i32 {
    let mut wide: Vec<u16> = text.encode_utf16().collect();
    let mut rect = RECT::default();
    let _ = DrawTextW(
        dc,
        &mut wide,
        &mut rect,
        DT_CALCRECT | DT_SINGLELINE | DT_NOPREFIX,
    );
    rect.right - rect.left
}

unsafe fn draw_quota_row(
    dc: HDC,
    row: &QuotaBarRow,
    left: i32,
    right: i32,
    top: i32,
    font: HFONT,
    threshold: u32,
) {
    let warning = (threshold > 0 && row.percent >= threshold as f64) || row.percent >= 99.5;
    let _ = SelectObject(dc, font);
    set_text_color(dc, if warning { 0x0024bffb } else { 0x00a6a6a6 });
    draw_text(
        dc,
        &row.label,
        RECT {
            left,
            top,
            right: left + 190,
            bottom: top + 16,
        },
        DT_LEFT | DT_SINGLELINE | DT_VCENTER | DT_END_ELLIPSIS,
    );
    if let Some(reset) = format_reset(row.reset_at) {
        set_text_color(dc, 0x00868686);
        draw_text(
            dc,
            &reset,
            RECT {
                left: left + 196,
                top,
                right,
                bottom: top + 16,
            },
            DT_RIGHT | DT_SINGLELINE | DT_VCENTER | DT_END_ELLIPSIS,
        );
    }

    let bar_right = right - 76;
    fill_solid(
        dc,
        RECT {
            left,
            top: top + 19,
            right: bar_right,
            bottom: top + 24,
        },
        0x00303030,
    );
    draw_quota_fill(dc, left, bar_right, top + 19, row.percent, warning);
    set_text_color(dc, if warning { 0x0024bffb } else { 0x00ececec });
    let percent = if row.percent >= 99.5 {
        format!("{} limit", format_percent(row.percent))
    } else {
        format!("{} used", format_percent(row.percent))
    };
    draw_text(
        dc,
        &percent,
        RECT {
            left: bar_right + 8,
            top: top + 12,
            right,
            bottom: top + 29,
        },
        DT_RIGHT | DT_SINGLELINE | DT_VCENTER | DT_END_ELLIPSIS,
    );
}

unsafe fn draw_quota_fill(dc: HDC, left: i32, right: i32, top: i32, percent: f64, warning: bool) {
    let available = (right - left).max(0);
    let clamped = percent.clamp(0.0, 100.0);
    let mut filled = ((available as f64) * clamped / 100.0).round() as i32;
    if clamped > 0.0 {
        filled = filled.max(4);
    }
    filled = filled.min(available);
    if filled <= 0 {
        return;
    }
    if !warning {
        fill_solid(
            dc,
            RECT {
                left,
                top,
                right: left + filled,
                bottom: top + 5,
            },
            0x009dcb4e,
        );
        return;
    }

    let segments = filled.min(16).max(1);
    for index in 0..segments {
        let x0 = left + filled * index / segments;
        let x1 = left + filled * (index + 1) / segments;
        let t = if segments <= 1 {
            1.0
        } else {
            index as f64 / (segments - 1) as f64
        };
        fill_solid(
            dc,
            RECT {
                left: x0,
                top,
                right: x1,
                bottom: top + 5,
            },
            mix_color(0x009dcb4e, 0x0024bffb, t),
        );
    }
}

unsafe fn fill_solid(dc: HDC, rect: RECT, color: u32) {
    let brush = CreateSolidBrush(COLORREF(color));
    let _ = FillRect(dc, &rect, brush);
    let _ = DeleteObject(brush);
}

fn mix_color(from: u32, to: u32, t: f64) -> u32 {
    let blend = |shift: u32| {
        let a = ((from >> shift) & 0xff) as f64;
        let b = ((to >> shift) & 0xff) as f64;
        (a + (b - a) * t).round() as u32
    };
    blend(0) | (blend(8) << 8) | (blend(16) << 16)
}

fn format_reset(reset_at: Option<f64>) -> Option<String> {
    let reset_at = reset_at?;
    if !reset_at.is_finite() {
        return None;
    }
    let reset_ms = if reset_at < 10_000_000_000.0 {
        reset_at * 1000.0
    } else {
        reset_at
    };
    let now_ms = SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .ok()?
        .as_millis() as f64;
    let remaining = ((reset_ms - now_ms) / 1000.0).max(0.0) as u64;
    let days = remaining / 86_400;
    let hours = (remaining % 86_400) / 3_600;
    let minutes = (remaining % 3_600) / 60;
    Some(if days > 0 {
        format!("resets {days}d {hours}h")
    } else if hours > 0 {
        format!("resets {hours}h {minutes}m")
    } else if minutes > 0 {
        format!("resets {minutes}m")
    } else {
        "resets now".into()
    })
}

fn point_in(rect: &RECT, x: i32, y: i32) -> bool {
    x >= rect.left && x < rect.right && y >= rect.top && y < rect.bottom
}

fn window_placement_path() -> Option<PathBuf> {
    std::env::var_os("LOCALAPPDATA")
        .map(|root| PathBuf::from(root).join("OCX Notch").join("window.json"))
}

fn load_window_placement() -> Option<WindowPlacement> {
    let bytes = fs::read(window_placement_path()?).ok()?;
    serde_json::from_slice(&bytes).ok()
}

unsafe fn save_window_placement(hwnd: HWND) {
    let Some(path) = window_placement_path() else {
        return;
    };
    let mut rect = RECT::default();
    if GetWindowRect(hwnd, &mut rect).is_err() {
        return;
    }
    let width = APP
        .get()
        .and_then(|app| app.lock().ok().map(|app| app.width))
        .unwrap_or(rect.right - rect.left)
        .clamp(MIN_WIDTH, MAX_WIDTH);
    let placement = WindowPlacement {
        x: rect.left,
        y: rect.top,
        width,
    };
    let Some(parent) = path.parent() else {
        return;
    };
    let Ok(bytes) = serde_json::to_vec(&placement) else {
        return;
    };
    if fs::create_dir_all(parent).is_ok() {
        let _ = fs::write(path, bytes);
    }
}

unsafe fn restore_window_placement(hwnd: HWND, placement: WindowPlacement, height: i32) -> i32 {
    let saved_width = placement.width.clamp(MIN_WIDTH, MAX_WIDTH);
    let saved_rect = RECT {
        left: placement.x,
        top: placement.y,
        right: placement.x + saved_width,
        bottom: placement.y + height,
    };
    let monitor = MonitorFromRect(&saved_rect, MONITOR_DEFAULTTONEAREST);
    let mut info = MONITORINFO {
        cbSize: size_of::<MONITORINFO>() as u32,
        ..Default::default()
    };
    let _ = GetMonitorInfoW(monitor, &mut info);
    let work_width = (info.rcWork.right - info.rcWork.left).max(MIN_WIDTH);
    let width = saved_width.min(work_width);
    let x = placement
        .x
        .clamp(info.rcWork.left, info.rcWork.right - width);
    let y = placement.y.clamp(
        info.rcWork.top,
        (info.rcWork.bottom - height).max(info.rcWork.top),
    );
    let _ = SetWindowPos(hwnd, HWND_TOPMOST, x, y, width, height, SWP_NOACTIVATE);
    width
}

fn power_control_rect(width: i32) -> RECT {
    RECT {
        left: width - 36,
        top: 16,
        right: width - 10,
        bottom: 42,
    }
}

fn power_hit_rect(width: i32) -> RECT {
    RECT {
        left: width - 44,
        top: 3,
        right: width - 4,
        bottom: 56,
    }
}

fn minimize_control_rect(width: i32) -> RECT {
    RECT {
        left: width - 68,
        top: 16,
        right: width - 42,
        bottom: 42,
    }
}

fn minimize_hit_rect(width: i32) -> RECT {
    RECT {
        left: width - 76,
        top: 3,
        right: width - 36,
        bottom: 56,
    }
}

#[cfg(test)]
mod account_control_tests {
    use super::*;

    #[test]
    fn action_follows_short_identity_and_stays_before_health_column() {
        let rect = account_action_rect(DEFAULT_WIDTH, 120, 96);
        assert_eq!(rect.left, ACCOUNT_IDENTITY_LEFT + 96 + ACCOUNT_ACTION_GAP);
        assert_eq!(rect.right - rect.left, ACCOUNT_ACTION_WIDTH);
        assert!(rect.right <= DEFAULT_WIDTH - 244);
    }

    #[test]
    fn long_identity_cannot_push_action_into_health_column() {
        let rect = account_action_rect(DEFAULT_WIDTH, 120, 2_000);
        assert_eq!(rect.right, DEFAULT_WIDTH - 244 - ACCOUNT_ACTION_GAP);
    }
}

unsafe fn resize_for_state(hwnd: HWND) {
    let (width, height, user_positioned) = APP
        .get()
        .and_then(|app| {
            app.lock().ok().map(|mut app| {
                let height = app.desired_height();
                app.clamp_scroll(height);
                (app.width, height, app.user_positioned)
            })
        })
        .unwrap_or((DEFAULT_WIDTH, COLLAPSED_HEIGHT, false));
    if user_positioned {
        let mut rect = RECT::default();
        let _ = GetWindowRect(hwnd, &mut rect);
        let _ = SetWindowPos(
            hwnd,
            HWND_TOPMOST,
            rect.left,
            rect.top,
            width,
            height,
            SWP_NOACTIVATE,
        );
    } else {
        position_window(hwnd, width, height);
    }
    apply_round_region(hwnd, width, height);
}

unsafe fn position_window(hwnd: HWND, width: i32, height: i32) {
    let monitor = MonitorFromWindow(hwnd, MONITOR_DEFAULTTOPRIMARY);
    let mut info = MONITORINFO {
        cbSize: size_of::<MONITORINFO>() as u32,
        ..Default::default()
    };
    let _ = GetMonitorInfoW(monitor, &mut info);
    let x = info.rcWork.left + (info.rcWork.right - info.rcWork.left - width) / 2;
    let y = info.rcWork.top + 6;
    let _ = SetWindowPos(hwnd, HWND_TOPMOST, x, y, width, height, SWP_NOACTIVATE);
}

unsafe fn position_window_on_cursor(hwnd: HWND, width: i32, height: i32) {
    let mut point = POINT::default();
    let _ = GetCursorPos(&mut point);
    let monitor = MonitorFromPoint(point, MONITOR_DEFAULTTOPRIMARY);
    position_on_monitor(hwnd, width, height, monitor);
}

unsafe fn position_on_monitor(hwnd: HWND, width: i32, height: i32, monitor: HMONITOR) {
    let mut info = MONITORINFO {
        cbSize: size_of::<MONITORINFO>() as u32,
        ..Default::default()
    };
    let _ = GetMonitorInfoW(monitor, &mut info);
    let x = info.rcWork.left + (info.rcWork.right - info.rcWork.left - width) / 2;
    let y = info.rcWork.top + 6;
    let _ = SetWindowPos(hwnd, HWND_TOPMOST, x, y, width, height, SWP_NOACTIVATE);
}

unsafe fn apply_round_region(hwnd: HWND, width: i32, height: i32) {
    let region = CreateRoundRectRgn(0, 0, width + 1, height + 1, 22, 22);
    let _ = SetWindowRgn(hwnd, region, true);
}

unsafe fn show_context_menu(hwnd: HWND) {
    let menu = CreatePopupMenu().unwrap_or_default();
    let threshold_menu = CreatePopupMenu().unwrap_or_default();
    let current = APP
        .get()
        .and_then(|app| app.lock().ok().map(|app| app.state.auto_switch_threshold))
        .unwrap_or(80);
    for threshold in [0_u32, 50, 60, 70, 75, 80, 85, 90, 95, 100] {
        let flags = if threshold == current {
            MF_STRING | MF_CHECKED
        } else {
            MF_STRING
        };
        let label = if threshold == 0 {
            "Off".to_string()
        } else {
            format!("{threshold}%")
        };
        let label: Vec<u16> = label.encode_utf16().chain(Some(0)).collect();
        let _ = AppendMenuW(
            threshold_menu,
            flags,
            MENU_THRESHOLD_BASE + threshold as usize,
            PCWSTR(label.as_ptr()),
        );
    }
    let _ = AppendMenuW(
        menu,
        MF_POPUP,
        threshold_menu.0 as usize,
        w!("Rotation threshold"),
    );
    let _ = AppendMenuW(menu, MF_STRING, MENU_THRESHOLD_DOWN, w!("Threshold -1%"));
    let _ = AppendMenuW(menu, MF_STRING, MENU_THRESHOLD_UP, w!("Threshold +1%"));
    let _ = AppendMenuW(menu, MF_SEPARATOR, 0, None);
    let _ = AppendMenuW(menu, MF_STRING, MENU_REFRESH, w!("Refresh"));
    let _ = AppendMenuW(menu, MF_SEPARATOR, 0, None);
    let _ = AppendMenuW(menu, MF_STRING, MENU_EXIT, w!("Exit"));
    let mut point = POINT::default();
    let _ = GetCursorPos(&mut point);
    let _ = SetForegroundWindow(hwnd);
    let _ = TrackPopupMenu(menu, TPM_RIGHTBUTTON, point.x, point.y, 0, hwnd, None);
    let _ = DestroyMenu(menu);
}
