#![cfg_attr(not(debug_assertions), windows_subsystem = "windows")]

mod api;
mod model;

use crate::model::*;
use std::collections::HashSet;
use std::mem::size_of;
use std::sync::atomic::{AtomicBool, AtomicU32, Ordering};
use std::sync::mpsc::{self, Receiver, Sender};
use std::sync::{Arc, Mutex, OnceLock};
use std::thread;
use std::time::{Duration, Instant, SystemTime, UNIX_EPOCH};
use windows::core::{w, PCWSTR};
use windows::Win32::Foundation::*;
use windows::Win32::Graphics::Gdi::*;
use windows::Win32::System::LibraryLoader::GetModuleHandleW;
use windows::Win32::System::ProcessStatus::{K32GetProcessMemoryInfo, PROCESS_MEMORY_COUNTERS_EX};
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
const WIDTH: i32 = 640;
const COLLAPSED_HEIGHT: i32 = 58;
const USAGE_TOGGLE_HEIGHT: i32 = 42;

static APP: OnceLock<Mutex<App>> = OnceLock::new();

enum Update {
    NativeMemory {
        pid: u32,
        working_set: u64,
        private_commit: u64,
    },
    Health(Result<Health, String>),
    MemoryDetails(Result<MemoryDetails, String>),
    Usage(Result<UsageResponse, String>),
    Providers(Result<Vec<ProviderConfig>, String>),
    Quotas(Result<QuotaResponse, String>),
    AutoSwitch(Result<AutoSwitchState, String>),
    Pools(Vec<AccountPool>),
}

#[derive(Default)]
struct ViewState {
    online: bool,
    status: String,
    pid: u32,
    working_set: u64,
    private_commit: u64,
    details: Option<MemoryDetails>,
    configs: Vec<ProviderConfig>,
    quotas: Vec<QuotaReport>,
    usage: Vec<UsageProvider>,
    pools: Vec<AccountPool>,
    providers: Vec<ProviderView>,
    auto_switch_threshold: u32,
}

struct App {
    rx: Receiver<Update>,
    state: ViewState,
    expanded: bool,
    scroll_offset: i32,
    expanded_providers: HashSet<String>,
    provider_hits: Vec<(RECT, String)>,
    show_usage_only: bool,
    usage_toggle_hit: Option<RECT>,
    drag_origin: Option<(POINT, RECT)>,
    drag_moved: bool,
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
                } => {
                    self.state.pid = pid;
                    self.state.working_set = working_set;
                    self.state.private_commit = private_commit;
                }
                Update::Health(result) => match result {
                    Ok(health) => {
                        self.state.online = true;
                        self.state.pid = health.pid;
                        self.state.status = "Connected".into();
                    }
                    Err(error) => {
                        self.state.online = false;
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
                        self.state.auto_switch_threshold = value.auto_switch_threshold.min(100)
                    }
                    Err(error) => self.state.status = error,
                },
                Update::Pools(value) => self.state.pools = value,
            }
        }
        self.state.providers = merge_providers(
            &self.state.configs,
            &self.state.quotas,
            &self.state.usage,
            &self.state.pools,
        );
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
            WIDTH,
            COLLAPSED_HEIGHT,
            None,
            None,
            instance,
            None,
        )?;
        SetLayeredWindowAttributes(hwnd, COLORREF(0), 238, LWA_ALPHA)?;
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
            show_usage_only: false,
            usage_toggle_hit: None,
            drag_origin: None,
            drag_moved: false,
            user_positioned: false,
            force_refresh: force_refresh.clone(),
            want_details: want_details.clone(),
        }))
        .ok();
        position_window_on_cursor(hwnd, COLLAPSED_HEIGHT);
        apply_round_region(hwnd, COLLAPSED_HEIGHT);
        let _ = ShowWindow(hwnd, SW_SHOWNOACTIVATE);
        start_workers(hwnd.0 as isize, tx, force_refresh, want_details);

        let mut message = MSG::default();
        while GetMessageW(&mut message, None, 0, 0).into() {
            let _ = TranslateMessage(&message);
            DispatchMessageW(&message);
        }
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
                send_update(
                    hwnd,
                    &api_tx,
                    Update::AutoSwitch(api::get_json("/api/codex-auth/active", 10_000)),
                );
                last_slow = Instant::now();
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
                send_update(
                    hwnd,
                    &tx,
                    Update::NativeMemory {
                        pid: current_pid,
                        working_set,
                        private_commit,
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
        WM_LBUTTONDOWN => {
            let mut cursor = POINT::default();
            let mut window = RECT::default();
            let _ = GetCursorPos(&mut cursor);
            let _ = GetWindowRect(hwnd, &mut window);
            with_app(|app| {
                app.drag_origin = Some((cursor, window));
                app.drag_moved = false;
            });
            let _ = SetCapture(hwnd);
            LRESULT(0)
        }
        WM_MOUSEMOVE => {
            let mut cursor = POINT::default();
            let _ = GetCursorPos(&mut cursor);
            let mut target = None;
            with_app(|app| {
                if let Some((origin, window)) = app.drag_origin {
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
            LRESULT(0)
        }
        WM_LBUTTONUP => {
            let _ = ReleaseCapture();
            let x = (lparam.0 as i16) as i32;
            let y = ((lparam.0 >> 16) as i16) as i32;
            let mut changed = false;
            let mut was_drag = false;
            with_app(|app| {
                was_drag = app.drag_moved;
                app.drag_origin = None;
                app.drag_moved = false;
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
                app.drag_moved = false;
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
    app.usage_toggle_hit = None;
    let title_font = make_font(18, 600);
    let body_font = make_font(14, 500);
    let small_font = make_font(12, 400);
    let old_font = SelectObject(dc, title_font);
    set_text_color(
        dc,
        if app.state.online {
            0x00e9f4ef
        } else {
            0x00b4b4bd
        },
    );
    draw_text(
        dc,
        "OCX",
        RECT {
            left: 18,
            top: 8,
            right: 72,
            bottom: 34,
        },
        DT_LEFT | DT_SINGLELINE | DT_VCENTER,
    );

    let private_text = if app.state.online && app.state.private_commit > 0 {
        format!("Private {}", format_bytes(app.state.private_commit))
    } else if app.state.online {
        "Private —".into()
    } else {
        "OCX offline".into()
    };
    let _ = SelectObject(dc, body_font);
    set_text_color(
        dc,
        if app.state.online {
            0x006ee7a8
        } else {
            0x006f7380
        },
    );
    draw_text(
        dc,
        &private_text,
        RECT {
            left: 76,
            top: 6,
            right: 210,
            bottom: 31,
        },
        DT_LEFT | DT_SINGLELINE | DT_VCENTER | DT_END_ELLIPSIS,
    );
    let ws = if app.state.working_set > 0 {
        format!("WS {}", format_bytes(app.state.working_set))
    } else {
        app.state.status.clone()
    };
    let _ = SelectObject(dc, small_font);
    set_text_color(dc, 0x009a9fa8);
    draw_text(
        dc,
        &ws,
        RECT {
            left: 76,
            top: 29,
            right: 210,
            bottom: 51,
        },
        DT_LEFT | DT_SINGLELINE | DT_VCENTER | DT_END_ELLIPSIS,
    );

    let mut x = 224;
    let summary_providers = app
        .state
        .providers
        .iter()
        .filter(|provider| provider_has_quota(provider))
        .chain(
            app.state
                .providers
                .iter()
                .filter(|provider| !provider_has_quota(provider)),
        );
    for provider in summary_providers.take(3) {
        let summary = provider
            .quota
            .as_ref()
            .and_then(Quota::primary)
            .map(|(_, value)| format!("{} {}", provider.label, format_percent(value)))
            .unwrap_or_else(|| format!("{} {}", provider.label, format_tokens(provider.tokens)));
        set_text_color(dc, 0x00d3d8df);
        draw_text(
            dc,
            &summary,
            RECT {
                left: x,
                top: 10,
                right: x + 124,
                bottom: 47,
            },
            DT_CENTER | DT_SINGLELINE | DT_VCENTER | DT_END_ELLIPSIS,
        );
        x += 126;
    }
    if app.state.providers.len() > 3 {
        set_text_color(dc, 0x008f949e);
        draw_text(
            dc,
            &format!("+{}", app.state.providers.len() - 3),
            RECT {
                left: width - 40,
                top: 10,
                right: width - 10,
                bottom: 47,
            },
            DT_CENTER | DT_SINGLELINE | DT_VCENTER,
        );
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
                for account in provider.accounts {
                    let account_height = account_height(&account);
                    set_text_color(dc, 0x00c7cbd2);
                    draw_text(
                        dc,
                        &account.identity,
                        RECT {
                            left: 42,
                            top: y,
                            right: width - 250,
                            bottom: y + 30,
                        },
                        DT_LEFT | DT_SINGLELINE | DT_VCENTER | DT_END_ELLIPSIS,
                    );
                    set_text_color(
                        dc,
                        if account.active {
                            0x006ee7a8
                        } else {
                            0x008e949e
                        },
                    );
                    let suffix = if account.active { " · active" } else { "" };
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
    let _ = DeleteObject(title_font);
    let _ = DeleteObject(body_font);
    let _ = DeleteObject(small_font);
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

unsafe fn resize_for_state(hwnd: HWND) {
    let (height, user_positioned) = APP
        .get()
        .and_then(|app| {
            app.lock().ok().map(|mut app| {
                let height = app.desired_height();
                app.clamp_scroll(height);
                (height, app.user_positioned)
            })
        })
        .unwrap_or((COLLAPSED_HEIGHT, false));
    if user_positioned {
        let mut rect = RECT::default();
        let _ = GetWindowRect(hwnd, &mut rect);
        let _ = SetWindowPos(
            hwnd,
            HWND_TOPMOST,
            rect.left,
            rect.top,
            WIDTH,
            height,
            SWP_NOACTIVATE,
        );
    } else {
        position_window(hwnd, height);
    }
    apply_round_region(hwnd, height);
}

unsafe fn position_window(hwnd: HWND, height: i32) {
    let monitor = MonitorFromWindow(hwnd, MONITOR_DEFAULTTOPRIMARY);
    let mut info = MONITORINFO {
        cbSize: size_of::<MONITORINFO>() as u32,
        ..Default::default()
    };
    let _ = GetMonitorInfoW(monitor, &mut info);
    let x = info.rcWork.left + (info.rcWork.right - info.rcWork.left - WIDTH) / 2;
    let y = info.rcWork.top + 6;
    let _ = SetWindowPos(hwnd, HWND_TOPMOST, x, y, WIDTH, height, SWP_NOACTIVATE);
}

unsafe fn position_window_on_cursor(hwnd: HWND, height: i32) {
    let mut point = POINT::default();
    let _ = GetCursorPos(&mut point);
    let monitor = MonitorFromPoint(point, MONITOR_DEFAULTTOPRIMARY);
    position_on_monitor(hwnd, height, monitor);
}

unsafe fn position_on_monitor(hwnd: HWND, height: i32, monitor: HMONITOR) {
    let mut info = MONITORINFO {
        cbSize: size_of::<MONITORINFO>() as u32,
        ..Default::default()
    };
    let _ = GetMonitorInfoW(monitor, &mut info);
    let x = info.rcWork.left + (info.rcWork.right - info.rcWork.left - WIDTH) / 2;
    let y = info.rcWork.top + 6;
    let _ = SetWindowPos(hwnd, HWND_TOPMOST, x, y, WIDTH, height, SWP_NOACTIVATE);
}

unsafe fn apply_round_region(hwnd: HWND, height: i32) {
    let region = CreateRoundRectRgn(0, 0, WIDTH + 1, height + 1, 22, 22);
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
