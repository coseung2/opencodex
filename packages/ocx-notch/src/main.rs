#![cfg_attr(not(debug_assertions), windows_subsystem = "windows")]

mod api;
mod callback_relay;
mod model;
mod models;
mod subagents;

use crate::callback_relay::CallbackRelay;
use crate::model::*;
use crate::models::{
    ModelRow, ModelVisibilityRequest, ModelsState, SelectedModelsResponse, VisibilityTarget,
};
use crate::subagents::{
    InjectionModelResponse, SubagentModelsRequest, SubagentModelsResponse, SubagentState,
};
use serde::{Deserialize, Serialize};
use std::collections::{HashMap, HashSet};
use std::fs::{self, OpenOptions};
use std::io::Write;
use std::mem::size_of;
use std::panic;
use std::path::PathBuf;
use std::sync::atomic::{AtomicBool, AtomicU32, Ordering};
use std::sync::mpsc::{self, Receiver, Sender};
use std::sync::{Arc, Mutex, OnceLock};
use std::thread;
use std::time::{Duration, Instant, SystemTime, UNIX_EPOCH};
use windows::core::{w, PCWSTR};
use windows::Win32::Foundation::*;
use windows::Win32::Graphics::Gdi::*;
use windows::Win32::System::DataExchange::{
    CloseClipboard, EmptyClipboard, OpenClipboard, SetClipboardData,
};
use windows::Win32::System::LibraryLoader::GetModuleHandleW;
use windows::Win32::System::Memory::{GlobalAlloc, GlobalLock, GlobalUnlock, GMEM_MOVEABLE};
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
const MENU_PROVIDER_ADD: usize = 5;
const MENU_CONNECTION: usize = 6;
const MENU_THRESHOLD_BASE: usize = 1_000;
const API_KEY_EDIT_ID: i32 = 30_001;
const ACCOUNT_ID_EDIT_ID: i32 = 30_002;
const KIRO_START_URL_EDIT_ID: i32 = 30_003;
const KIRO_REGION_EDIT_ID: i32 = 30_004;
const CONNECTION_URL_EDIT_ID: i32 = 30_005;
const CONNECTION_TOKEN_EDIT_ID: i32 = 30_006;
const DEFAULT_WIDTH: i32 = 640;
const MIN_WIDTH: i32 = 320;
const MAX_WIDTH: i32 = 1_200;
const RESIZE_EDGE: i32 = 7;
const COLLAPSED_HEIGHT: i32 = 58;
const CONTENT_TOP: i32 = 101;
const LOG_ROW_HEIGHT: i32 = 44;
const EMPTY_LOG_HEIGHT: i32 = 84;
const POWER_PROBE_INTERVAL: Duration = Duration::from_millis(75);
const POWER_HEALTH_TIMEOUT_MS: i32 = 175;
const HEADER_TEXT_RIGHT: i32 = 132;
const HEADER_CHART_LEFT: i32 = 140;
const HEADER_LABEL_WIDTH: i32 = 82;
const HEADER_LABEL_GAP: i32 = 8;
const ACCOUNT_IDENTITY_LEFT: i32 = 42;
const ACCOUNT_ACTION_WIDTH: i32 = 26;
const ACCOUNT_ACTION_HEIGHT: i32 = 30;
const ACCOUNT_ACTION_GAP: i32 = 4;
const RESET_CREDIT_ACTION_WIDTH: i32 = 34;
const REAUTH_ACTION_WIDTH: i32 = 142;
const GIB: u64 = 1024 * 1024 * 1024;
const DIAGNOSTIC_LOG_MAX_BYTES: u64 = 512 * 1024;

static APP: OnceLock<Mutex<App>> = OnceLock::new();
static LUCIDE_FONT_BYTES: &[u8] = include_bytes!("../assets/lucide-subset.ttf");

#[derive(Clone, Copy, PartialEq, Eq)]
enum Button {
    Power,
    Minimize,
}

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
enum ContentTab {
    Providers,
    Logs,
    Models,
    Subagents,
}

#[derive(Clone, Debug, PartialEq, Eq)]
enum ModelHit {
    ToggleProvider(String),
    SetProviderVisibility {
        provider: String,
        enabled: bool,
    },
    SetModelVisibility {
        provider: String,
        id: String,
        native: bool,
        enabled: bool,
    },
}

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
enum ProviderVisibility {
    AllOn,
    AllOff,
    Mixed,
}

#[derive(Clone, PartialEq, Eq)]
enum SubagentHit {
    ToggleFeatured(String),
    MoveFeatured(usize, isize),
    CycleModel,
    CycleEffort,
    ToggleGuidance,
    ToggleSyncDefaults,
    Save,
}

#[derive(Clone, PartialEq, Eq)]
struct AccountControl {
    provider: String,
    kind: String,
    id: String,
    paused: bool,
}

#[derive(Clone, PartialEq, Eq)]
struct AccountSwitchControl {
    provider: String,
    id: String,
    kind: String,
}

#[derive(Clone, PartialEq, Eq)]
struct ReauthControl {
    provider: String,
    id: String,
}

#[derive(Clone, PartialEq, Eq)]
struct ResetCreditControl {
    id: String,
    identity: String,
    available: u32,
}

#[derive(Default)]
struct AuthCancellation {
    requested: AtomicBool,
    flow_id: Mutex<Option<String>>,
}

impl AuthCancellation {
    fn request(&self) {
        self.requested.store(true, Ordering::Release);
    }

    fn is_requested(&self) -> bool {
        self.requested.load(Ordering::Acquire)
    }

    fn publish_flow_id(&self, flow_id: String) -> bool {
        *self
            .flow_id
            .lock()
            .unwrap_or_else(|poisoned| poisoned.into_inner()) = Some(flow_id);
        self.is_requested()
    }

    fn flow_id(&self) -> Option<String> {
        self.flow_id
            .lock()
            .unwrap_or_else(|poisoned| poisoned.into_inner())
            .clone()
    }
}

#[derive(Clone, PartialEq, Eq)]
enum ModalHit {
    CopyAuthUrl,
    Preset(usize),
    Tab(ProviderCatalogTab),
    AddKey,
    KiroPersonal,
    KiroOrganization,
    KiroOrganizationSubmit,
    ResetCreditUse,
    ResetCreditConfirm,
    ResetCreditConfirmCancel,
    ConnectionModeLocal,
    ConnectionModeRemote,
    ConnectionSave,
    Cancel,
}

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
enum ProviderCatalogTab {
    Accounts,
    Free,
    Paid,
}

enum ProviderModal {
    Picker {
        presets: Vec<ProviderPreset>,
        loading: bool,
        error: Option<String>,
        waiting_provider: Option<String>,
        waiting_codex: bool,
        auth_details: Option<AuthFlowResponse>,
        url_copied_at: Option<Instant>,
        cancel: Option<Arc<AuthCancellation>>,
        scroll: i32,
        selected_tab: ProviderCatalogTab,
    },
    ApiKey {
        preset: ProviderPreset,
        submitting: bool,
        error: Option<String>,
        /// True when the provider already exists: submitting adds the key to its
        /// multi-key pool (POST /api/providers/keys) instead of replacing the row.
        add_key: bool,
    },
    KiroAccountChoice,
    KiroOrganization {
        error: Option<String>,
    },
    /// Local/Remote connection setup. `remote` is the mode being edited, not the
    /// mode currently in force: nothing changes until Save succeeds.
    Connection {
        remote: bool,
        submitting: bool,
        error: Option<String>,
    },
    ResetCredits {
        control: ResetCreditControl,
        credits: Vec<ResetCredit>,
        loading: bool,
        confirming: bool,
        submitting: bool,
        error: Option<String>,
    },
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
    Logs(Result<RequestLogsResponse, String>),
    Providers(Result<Vec<ProviderConfig>, String>),
    Quotas(Result<QuotaResponse, String>),
    AutoSwitch(Result<AutoSwitchState, String>),
    Pools(Vec<AccountPool>),
    OpenAiPool(Result<AccountPool, String>),
    Models(Result<(Vec<ModelRow>, SelectedModelsResponse), String>),
    Subagents(Result<(SubagentModelsResponse, InjectionModelResponse), String>),
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
    /// True when this Notch is pointed at a central OCX. Mirrors
    /// `api::is_remote()`, refreshed whenever the connection changes.
    remote: bool,
    /// Why a stored remote connection is unusable, when it is.
    connection_error: Option<String>,
    configs: Vec<ProviderConfig>,
    quotas: Vec<QuotaReport>,
    usage: Vec<UsageProvider>,
    logs: Vec<RequestLogEntry>,
    logs_error: Option<String>,
    pools: Vec<AccountPool>,
    providers: Vec<ProviderView>,
    auto_switch_threshold: u32,
    active_codex_account_id: Option<String>,
    models: ModelsState,
    subagents: SubagentState,
}

struct App {
    rx: Receiver<Update>,
    state: ViewState,
    expanded: bool,
    content_tab: ContentTab,
    hot_tab: Option<ContentTab>,
    scroll_offset: i32,
    expanded_providers: HashSet<String>,
    expanded_model_providers: HashSet<String>,
    provider_hits: Vec<(RECT, String)>,
    account_pause_hits: Vec<(RECT, AccountControl)>,
    account_switch_hits: Vec<(RECT, AccountSwitchControl)>,
    account_delete_hits: Vec<(RECT, AccountSwitchControl)>,
    account_reauth_hits: Vec<(RECT, ReauthControl)>,
    account_reset_credit_hits: Vec<(RECT, ResetCreditControl)>,
    model_hits: Vec<(RECT, ModelHit)>,
    subagent_hits: Vec<(RECT, SubagentHit)>,
    modal_hits: Vec<(RECT, ModalHit)>,
    hot_account_control: Option<AccountControl>,
    hot_account_switch: Option<AccountSwitchControl>,
    hot_account_delete: Option<AccountSwitchControl>,
    hot_reauth_control: Option<ReauthControl>,
    hot_reset_credit_control: Option<ResetCreditControl>,
    pressed_account_control: Option<AccountControl>,
    pressed_account_switch: Option<AccountSwitchControl>,
    pressed_account_delete: Option<AccountSwitchControl>,
    pressed_reauth_control: Option<ReauthControl>,
    pressed_reset_credit_control: Option<ResetCreditControl>,
    pressed_model_hit: Option<ModelHit>,
    pressed_subagent_hit: Option<SubagentHit>,
    pressed_modal_hit: Option<ModalHit>,
    account_mutations: HashSet<String>,
    account_switch_mutations: HashSet<String>,
    switch_previous_active: HashMap<String, Option<String>>,
    reauth_mutations: HashMap<String, Arc<AuthCancellation>>,
    reset_credit_mutations: HashSet<String>,
    provider_modal: Option<ProviderModal>,
    modal_generation: u64,
    api_key_edit: Option<isize>,
    account_id_edit: Option<isize>,
    kiro_start_url_edit: Option<isize>,
    kiro_region_edit: Option<isize>,
    connection_url_edit: Option<isize>,
    connection_token_edit: Option<isize>,
    context_menu_open: bool,
    pause_overrides: HashMap<String, bool>,
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
    want_logs: Arc<AtomicBool>,
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
                } => apply_local_process_memory(
                    &mut self.state,
                    pid,
                    working_set,
                    private_commit,
                    system_memory,
                ),
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
                        apply_memory_details(&mut self.state, details);
                    }
                }
                Update::Usage(result) => match result {
                    Ok(value) => self.state.usage = value.latest_day_providers(),
                    Err(error) => self.state.status = error,
                },
                Update::Logs(result) => match result {
                    Ok(value) => {
                        self.state.logs = latest_request_logs(value.into_logs());
                        self.state.logs_error = None;
                    }
                    Err(error) => self.state.logs_error = Some(error),
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
                Update::Models(result) => {
                    if self.state.models.mutating.is_empty() {
                        match result {
                            Ok((rows, selected)) => {
                                self.state.models.apply_rows(rows);
                                self.state.models.apply_selected(selected);
                                self.state.models.message = None;
                            }
                            Err(error) => self.state.models.message = Some(error),
                        }
                    }
                }
                Update::Subagents(result) => {
                    if !self.state.subagents.saving {
                        match result {
                            Ok((models, injection)) => {
                                self.state.subagents.refresh(models, injection);
                            }
                            Err(error) => self.state.subagents.message = Some(error),
                        }
                    }
                }
            }
        }
        mark_codex_active_account(
            &mut self.state.pools,
            self.state.active_codex_account_id.as_deref(),
        );
        self.rebuild_provider_views();
    }

    fn rebuild_provider_views(&mut self) {
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
        if self.provider_modal.is_some() {
            return 560;
        }
        if !self.expanded {
            return COLLAPSED_HEIGHT;
        }
        // Content runs from CONTENT_TOP; the 6px bottom gap matches the header's
        // 6px top padding so the expanded panel is vertically balanced.
        (107 + self.content_height()).clamp(180, 720)
    }

    fn content_height(&self) -> i32 {
        if self.content_tab == ContentTab::Logs {
            return if self.state.logs.is_empty() {
                EMPTY_LOG_HEIGHT
            } else {
                self.state.logs.len() as i32 * LOG_ROW_HEIGHT
            };
        }
        if self.content_tab == ContentTab::Models {
            return models_content_height(&self.state.models, &self.expanded_model_providers);
        }
        if self.content_tab == ContentTab::Subagents {
            return subagent_content_height(&self.state.subagents);
        }
        let mut height = 0;
        for provider in &self.state.providers {
            height += provider_height(provider);
            if self.expanded_providers.contains(&provider.name) {
                height += provider.accounts.iter().map(account_height).sum::<i32>();
            }
        }
        height
    }

    fn clamp_scroll(&mut self, window_height: i32) {
        let viewport = (window_height - CONTENT_TOP).max(1);
        self.scroll_offset = self
            .scroll_offset
            .clamp(0, (self.content_height() - viewport).max(0));
    }
}

struct QuotaBarRow {
    label: String,
    percent: f64,
    reset_at: Option<f64>,
    value_label: Option<String>,
    segments: Vec<QuotaSegment>,
}

/// A display column derived from one quota window supplied by the management
/// API. Standard fields and provider-specific `customWindows` are flattened
/// into the same shape so the notch never needs to know a plan name or API
/// family when laying out the row.
struct QuotaBarColumn {
    label: String,
    percent: Option<f64>,
    reset_at: Option<f64>,
    value_label: Option<String>,
}

fn quota_rows(quota: Option<&Quota>) -> Vec<QuotaBarRow> {
    let Some(quota) = quota else {
        return Vec::new();
    };
    let mut rows = Vec::new();
    if let Some(percent) = quota.five_hour_percent {
        rows.push(QuotaBarRow {
            label: "5h".into(),
            percent,
            reset_at: quota.five_hour_reset_at,
            value_label: None,
            segments: Vec::new(),
        });
    }
    if let Some(percent) = quota.weekly_percent {
        rows.push(QuotaBarRow {
            label: "Weekly".into(),
            percent,
            reset_at: quota.weekly_reset_at,
            value_label: None,
            segments: Vec::new(),
        });
    }
    if let Some(percent) = quota.monthly_percent {
        rows.push(QuotaBarRow {
            label: "Monthly".into(),
            percent,
            reset_at: quota.monthly_reset_at,
            value_label: None,
            segments: Vec::new(),
        });
    }
    for window in &quota.custom_windows {
        if let Some(percent) = window.percent {
            rows.push(QuotaBarRow {
                label: window.label.clone(),
                percent,
                reset_at: window.reset_at,
                value_label: window.value_label.clone(),
                segments: window.segments.clone(),
            });
        }
    }
    rows
}

fn quota_columns(quota: Option<&Quota>) -> Vec<QuotaBarColumn> {
    quota_rows(quota)
        .into_iter()
        .flat_map(|row| {
            if row.segments.is_empty() {
                return vec![QuotaBarColumn {
                    label: row.label,
                    percent: Some(row.percent),
                    reset_at: row.reset_at,
                    value_label: row.value_label,
                }];
            }
            row.segments
                .into_iter()
                .filter_map(|segment| {
                    segment.percent.map(|percent| QuotaBarColumn {
                        label: segment.label,
                        percent: Some(percent),
                        reset_at: segment.reset_at,
                        value_label: None,
                    })
                })
                .collect()
        })
        .collect()
}

fn provider_has_quota(provider: &ProviderView) -> bool {
    !quota_columns(provider.quota.as_ref()).is_empty()
}

fn ordered_provider_views(providers: &[ProviderView]) -> Vec<ProviderView> {
    let mut ordered = providers.to_vec();
    ordered.sort_by_key(|provider| !provider_has_quota(provider));
    ordered
}

fn provider_height(provider: &ProviderView) -> i32 {
    if quota_columns(provider.quota.as_ref()).is_empty() {
        48
    } else {
        38 + 28
    }
}

fn account_height(account: &AccountView) -> i32 {
    if quota_columns(account.quota.as_ref()).is_empty() {
        38
    } else {
        34 + 26
    }
}

/// Install a local process sample. Ignored in remote mode: the pid belongs to the
/// VM, so a local sample would describe an unrelated process on this PC.
fn apply_local_process_memory(
    state: &mut ViewState,
    pid: u32,
    working_set: u64,
    private_commit: u64,
    system_memory: Option<SystemMemory>,
) {
    if state.remote {
        return;
    }
    state.pid = pid;
    state.working_set = working_set;
    state.private_commit = private_commit;
    if let Some(system_memory) = system_memory {
        state.system_memory = Some(system_memory);
    }
}

/// Install `/api/system/memory`. In remote mode this is the only memory source,
/// so the server's own figures drive the header; local machine capacity is
/// dropped because it does not describe the VM.
fn apply_memory_details(state: &mut ViewState, details: MemoryDetails) {
    if state.remote {
        state.working_set = details.rss.unwrap_or(0);
        state.private_commit = details
            .observed_bytes
            .or(details.heap_total)
            .or(details.heap_used)
            .unwrap_or(0);
        state.system_memory = None;
    }
    state.details = Some(details);
}

fn reset_credit_count(account: &AccountView) -> Option<u32> {
    account
        .quota
        .as_ref()
        .and_then(|quota| quota.reset_credits)
        .filter(|count| *count > 0)
}

fn format_credit_timestamp(value: &str) -> String {
    let Some((date, rest)) = value.split_once('T') else {
        return value.chars().take(24).collect();
    };
    let time: String = rest.chars().take(5).collect();
    if date.len() == 10 && time.len() == 5 {
        format!(
            "{}.{:}.{:} {time} UTC",
            &date[0..4],
            &date[5..7],
            &date[8..10]
        )
    } else {
        value.chars().take(24).collect()
    }
}

fn main() {
    install_panic_logger();
    match parse_cli(std::env::args().skip(1)) {
        Ok(Cli::Window) => {}
        Ok(Cli::Connect(base_url)) => {
            // Token arrives on stdin, never on the command line, and is never echoed.
            std::process::exit(match api::save_connection_from_stdin(&base_url) {
                Ok(()) => {
                    println!("Connected to {}", api::connection_base_url());
                    0
                }
                Err(error) => {
                    eprintln!("{error}");
                    1
                }
            });
        }
        Ok(Cli::Local) => {
            std::process::exit(match api::save_connection(None, None) {
                Ok(()) => {
                    println!("Using the local OCX");
                    0
                }
                Err(error) => {
                    eprintln!("{error}");
                    1
                }
            });
        }
        Err(error) => {
            eprintln!("{error}");
            eprintln!("usage: ocx-notch [--connect <http://host:port> | --local]");
            std::process::exit(2);
        }
    }
    if let Err(error) = run() {
        append_diagnostic_log("startup-error", &format!("{error:?}"));
        std::process::exit(1);
    }
}

/// How this process was invoked. Bootstrap modes configure the connection and
/// exit; the default opens the notch window.
#[derive(Debug, PartialEq, Eq)]
enum Cli {
    Window,
    /// `--connect <base-url>`: read the management token from stdin and store the
    /// remote profile.
    Connect(String),
    /// `--local`: return to local mode and drop the stored credential.
    Local,
}

fn parse_cli(args: impl IntoIterator<Item = String>) -> Result<Cli, String> {
    let mut args = args.into_iter();
    let Some(first) = args.next() else {
        return Ok(Cli::Window);
    };
    let mode = match first.as_str() {
        "--local" => Cli::Local,
        // The token is deliberately not accepted here: an argv credential would
        // be visible to every process on the machine.
        "--connect" | "--remote-server" => {
            let base_url = args
                .next()
                .ok_or_else(|| format!("{first} needs a server address"))?;
            Cli::Connect(base_url)
        }
        other => return Err(format!("Unknown option: {other}")),
    };
    if args.next().is_some() {
        return Err("Too many arguments".into());
    }
    Ok(mode)
}

fn run() -> windows::core::Result<()> {
    unsafe {
        let _ = SetProcessDpiAwarenessContext(DPI_AWARENESS_CONTEXT_PER_MONITOR_AWARE_V2);
        if let Ok(existing) = FindWindowW(CLASS_NAME, PCWSTR::null()) {
            revive_existing_window(existing);
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
        let want_logs = Arc::new(AtomicBool::new(false));
        APP.set(Mutex::new(App {
            rx,
            state: ViewState {
                status: "Loading OCX…".into(),
                auto_switch_threshold: 80,
                remote: api::is_remote(),
                connection_error: api::connection_error(),
                ..Default::default()
            },
            expanded: false,
            content_tab: ContentTab::Providers,
            hot_tab: None,
            scroll_offset: 0,
            expanded_providers: HashSet::new(),
            expanded_model_providers: HashSet::new(),
            provider_hits: Vec::new(),
            account_pause_hits: Vec::new(),
            account_switch_hits: Vec::new(),
            account_delete_hits: Vec::new(),
            account_reauth_hits: Vec::new(),
            account_reset_credit_hits: Vec::new(),
            model_hits: Vec::new(),
            subagent_hits: Vec::new(),
            modal_hits: Vec::new(),
            hot_account_control: None,
            hot_account_switch: None,
            hot_account_delete: None,
            hot_reauth_control: None,
            hot_reset_credit_control: None,
            pressed_account_control: None,
            pressed_account_switch: None,
            pressed_account_delete: None,
            pressed_reauth_control: None,
            pressed_reset_credit_control: None,
            pressed_model_hit: None,
            pressed_subagent_hit: None,
            pressed_modal_hit: None,
            account_mutations: HashSet::new(),
            account_switch_mutations: HashSet::new(),
            switch_previous_active: HashMap::new(),
            reauth_mutations: HashMap::new(),
            reset_credit_mutations: HashSet::new(),
            provider_modal: None,
            modal_generation: 0,
            api_key_edit: None,
            account_id_edit: None,
            kiro_start_url_edit: None,
            kiro_region_edit: None,
            connection_url_edit: None,
            connection_token_edit: None,
            context_menu_open: false,
            pause_overrides: HashMap::new(),
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
            want_logs: want_logs.clone(),
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
        start_workers(hwnd.0 as isize, tx, force_refresh, want_details, want_logs);

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
    want_logs: Arc<AtomicBool>,
) {
    let pid = Arc::new(AtomicU32::new(0));
    let api_pid = pid.clone();
    let api_tx = tx.clone();
    thread::spawn(move || {
        let now = Instant::now();
        let mut last_health = refresh_seed(now, Duration::from_secs(60));
        let mut last_usage = refresh_seed(now, Duration::from_secs(60));
        let mut last_openai_pool = refresh_seed(now, Duration::from_secs(60));
        let mut last_active = refresh_seed(now, Duration::from_secs(60));
        let mut last_slow = refresh_seed(now, Duration::from_secs(600));
        let mut last_details = refresh_seed(now, Duration::from_secs(60));
        let mut last_logs = refresh_seed(now, Duration::from_secs(60));
        let mut last_models = refresh_seed(now, Duration::from_secs(600));
        let mut last_subagents = refresh_seed(now, Duration::from_secs(600));
        let mut slow_interval = Duration::from_secs(300);
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
            let logs_interval = logs_refresh_interval(want_logs.load(Ordering::Relaxed));
            if forced || last_logs.elapsed() >= logs_interval {
                send_update(
                    hwnd,
                    &api_tx,
                    Update::Logs(api::get_json("/api/logs?tail=10", 8_000)),
                );
                last_logs = Instant::now();
            }
            if forced || last_openai_pool.elapsed() >= account_quota_refresh_interval() {
                send_update(
                    hwnd,
                    &api_tx,
                    Update::OpenAiPool(api::fetch_codex_account_pool(true)),
                );
                last_openai_pool = Instant::now();
            }
            if forced || last_slow.elapsed() >= slow_interval {
                let configs = api::get_json::<Vec<ProviderConfig>>("/api/providers", 20_000);
                let configs_ok = configs.is_ok();
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
                slow_interval = provider_refresh_interval(configs_ok);
            }
            if forced || last_active.elapsed() >= Duration::from_secs(5) {
                send_update(
                    hwnd,
                    &api_tx,
                    Update::AutoSwitch(api::get_json("/api/codex-auth/active", 3_000)),
                );
                last_active = Instant::now();
            }
            if forced || last_models.elapsed() >= Duration::from_secs(300) {
                let models = (|| {
                    let rows = api::get_json("/api/models", 30_000)?;
                    let selected = api::get_json("/api/selected-models", 30_000)?;
                    Ok((rows, selected))
                })();
                send_update(hwnd, &api_tx, Update::Models(models));
                last_models = Instant::now();
            }
            if forced || last_subagents.elapsed() >= Duration::from_secs(300) {
                let subagents = (|| {
                    let models = api::get_json("/api/subagent-models", 30_000)?;
                    let injection = api::get_json("/api/injection-model", 30_000)?;
                    Ok((models, injection))
                })();
                send_update(hwnd, &api_tx, Update::Subagents(subagents));
                last_subagents = Instant::now();
            }
            // Remote mode has no local process to sample, so server memory is the
            // only source and is polled on the health cadence rather than only
            // while the details row is visible.
            let details_interval = if api::is_remote() {
                Duration::from_secs(5)
            } else {
                Duration::from_secs(45)
            };
            if (api::is_remote() || want_details.load(Ordering::Relaxed))
                && (forced || last_details.elapsed() >= details_interval)
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
        // Never OpenProcess in remote mode: the pid belongs to the VM, and any
        // local pid that happens to match would report an unrelated process.
        if current_pid != 0 && !api::is_remote() {
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

fn refresh_seed(now: Instant, age: Duration) -> Instant {
    now.checked_sub(age).unwrap_or(now)
}

fn logs_refresh_interval(visible: bool) -> Duration {
    Duration::from_secs(if visible { 2 } else { 30 })
}

fn account_quota_refresh_interval() -> Duration {
    Duration::from_secs(2)
}

fn provider_refresh_interval(last_fetch_succeeded: bool) -> Duration {
    Duration::from_secs(if last_fetch_succeeded { 300 } else { 5 })
}

fn send_update(hwnd: isize, tx: &Sender<Update>, update: Update) {
    if tx.send(update).is_ok() {
        unsafe {
            let _ = PostMessageW(HWND(hwnd as *mut _), WM_DATA, WPARAM(0), LPARAM(0));
        }
    }
}

fn launch_power_action(hwnd: HWND, action: &'static str) {
    // Remote mode owns no process here. The control is hidden, and this second
    // check keeps any future caller from starting or stopping the local OCX
    // while the notch is pointed at a central server.
    if api::is_remote() {
        with_app(|app| {
            app.power_pending = false;
            app.state.status = "Remote mode does not control the server process".into();
        });
        unsafe {
            let _ = InvalidateRect(hwnd, None, false);
        }
        return;
    }
    let hwnd_value = hwnd.0 as isize;
    thread::spawn(move || {
        let result = if action == "stop" {
            api::stop_ocx()
        } else {
            api::run_ocx_command(action)
        };
        if result.is_ok() {
            let deadline = Instant::now() + Duration::from_secs(15);
            loop {
                let health = api::get_json::<Health>("/healthz", POWER_HEALTH_TIMEOUT_MS);
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
                thread::sleep(POWER_PROBE_INTERVAL);
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

fn account_action_rect(width: i32, top: i32, identity_width: i32, has_reset_credit: bool) -> RECT {
    let min_left = ACCOUNT_IDENTITY_LEFT + 58;
    let reset_credit_width = if has_reset_credit {
        ACCOUNT_ACTION_GAP + RESET_CREDIT_ACTION_WIDTH
    } else {
        0
    };
    let max_left = (width - 244 - ACCOUNT_ACTION_GAP - ACCOUNT_ACTION_WIDTH - reset_credit_width)
        .max(min_left);
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

fn reset_credit_action_rect(account_action: RECT) -> RECT {
    RECT {
        left: account_action.right + ACCOUNT_ACTION_GAP,
        top: account_action.top,
        right: account_action.right + ACCOUNT_ACTION_GAP + RESET_CREDIT_ACTION_WIDTH,
        bottom: account_action.bottom,
    }
}

fn reauth_action_rect(width: i32, top: i32) -> RECT {
    let right = (width - 18).max(ACCOUNT_IDENTITY_LEFT + 84 + REAUTH_ACTION_WIDTH);
    RECT {
        left: right - REAUTH_ACTION_WIDTH,
        top,
        right,
        bottom: top + 30,
    }
}

fn reauth_eligible(provider: &str, account: &AccountView) -> bool {
    account.needs_reauth && !(provider == "openai" && (account.is_main || account.id == "__main__"))
}

fn reauth_text_color(_waiting: bool) -> u32 {
    0x0024bffb
}

fn open_reset_credit_modal(hwnd: HWND, control: ResetCreditControl) {
    let mut generation = 0;
    let mut opened = false;
    with_app(|app| {
        if app.reset_credit_mutations.contains(&control.id) {
            return;
        }
        app.expanded = true;
        app.modal_generation = app.modal_generation.wrapping_add(1);
        generation = app.modal_generation;
        app.provider_modal = Some(ProviderModal::ResetCredits {
            control: control.clone(),
            credits: Vec::new(),
            loading: true,
            confirming: false,
            submitting: false,
            error: None,
        });
        opened = true;
    });
    if !opened {
        return;
    }
    unsafe {
        resize_for_state(hwnd);
        let _ = InvalidateRect(hwnd, None, false);
    }
    let hwnd_value = hwnd.0 as isize;
    thread::spawn(move || {
        let result = api::fetch_reset_credits(&control.id);
        with_app(|app| {
            if app.modal_generation != generation {
                return;
            }
            if let Some(ProviderModal::ResetCredits {
                control,
                credits,
                loading,
                error,
                ..
            }) = &mut app.provider_modal
            {
                *loading = false;
                match result {
                    Ok(response) => {
                        control.available = response.available_count;
                        *credits = response.credits;
                    }
                    Err(message) => *error = Some(message),
                }
            }
        });
        unsafe {
            let _ = PostMessageW(HWND(hwnd_value as *mut _), WM_DATA, WPARAM(0), LPARAM(0));
        }
    });
}

fn submit_reset_credit(hwnd: HWND) {
    let mut account_id = None;
    with_app(|app| {
        let Some(ProviderModal::ResetCredits {
            control,
            loading,
            submitting,
            error,
            ..
        }) = &mut app.provider_modal
        else {
            return;
        };
        if *loading || *submitting || control.available == 0 {
            return;
        }
        *submitting = true;
        *error = None;
        account_id = Some(control.id.clone());
        app.reset_credit_mutations.insert(control.id.clone());
        app.state.status = "초기화권을 사용하는 중…".into();
    });
    let Some(account_id) = account_id else {
        return;
    };
    unsafe {
        let _ = InvalidateRect(hwnd, None, false);
    }

    let hwnd_value = hwnd.0 as isize;
    thread::spawn(move || {
        let result = api::consume_reset_credit(&account_id);
        with_app(|app| {
            app.reset_credit_mutations.remove(&account_id);
            match result {
                Ok(response) if matches!(response.code.as_str(), "reset" | "already_redeemed") => {
                    app.state.status = response.remaining.map_or_else(
                        || "초기화 완료".into(),
                        |remaining| format!("초기화 완료 · 남은 초기화권 {remaining}개"),
                    );
                    app.modal_generation = app.modal_generation.wrapping_add(1);
                    app.provider_modal = None;
                    app.force_refresh.store(true, Ordering::Release);
                }
                Ok(response) => {
                    if let Some(ProviderModal::ResetCredits {
                        submitting, error, ..
                    }) = &mut app.provider_modal
                    {
                        *submitting = false;
                        *error = Some(match response.code.as_str() {
                            "nothing_to_reset" => "현재 초기화할 사용량 제한이 없습니다".into(),
                            "no_credit" => "사용 가능한 초기화권이 없습니다".into(),
                            code => format!("초기화권 사용 실패: {code}"),
                        });
                    }
                }
                Err(message) => {
                    if let Some(ProviderModal::ResetCredits {
                        submitting, error, ..
                    }) = &mut app.provider_modal
                    {
                        *submitting = false;
                        *error = Some(message);
                    }
                }
            }
        });
        unsafe {
            let _ = PostMessageW(HWND(hwnd_value as *mut _), WM_DATA, WPARAM(0), LPARAM(0));
        }
    });
}

fn set_pool_account_paused(
    pools: &mut [AccountPool],
    provider: &str,
    id: &str,
    paused: bool,
) -> bool {
    let Some(account) = pools
        .iter_mut()
        .find(|pool| pool.provider == provider)
        .and_then(|pool| pool.accounts.iter_mut().find(|account| account.id == id))
    else {
        return false;
    };
    account.paused = paused;
    true
}

fn launch_pause_action(hwnd: HWND, control: AccountControl, paused: bool) {
    let mut started = false;
    with_app(|app| {
        if app.account_mutations.contains(&control.id) {
            return;
        }
        app.account_mutations.insert(control.id.clone());
        app.pause_overrides.insert(control.id.clone(), paused);
        set_pool_account_paused(&mut app.state.pools, &control.provider, &control.id, paused);
        app.rebuild_provider_views();
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
        let result = if control.kind == "oauth" {
            api::set_oauth_account_paused(&control.provider, &control.id, paused)
        } else {
            api::set_codex_account_paused(&control.id, paused)
        };
        with_app(|app| {
            app.account_mutations.remove(&control.id);
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
                    app.pause_overrides.remove(&control.id);
                    set_pool_account_paused(
                        &mut app.state.pools,
                        &control.provider,
                        &control.id,
                        !paused,
                    );
                    app.rebuild_provider_views();
                    app.state.status = error;
                }
            }
        });
        unsafe {
            let _ = PostMessageW(HWND(hwnd_value as *mut _), WM_DATA, WPARAM(0), LPARAM(0));
        }
    });
}

fn account_switch_mutation_key(provider: &str, id: &str) -> String {
    format!("{provider}:{id}")
}

fn launch_delete_action(hwnd: HWND, control: AccountSwitchControl) {
    let mut identity = None;
    with_app(|app| {
        identity = app
            .state
            .pools
            .iter()
            .find(|pool| pool.provider == control.provider)
            .and_then(|pool| {
                pool.accounts.iter().find(|account| {
                    account.id == control.id && !account.is_main && account.id != "__main__"
                })
            })
            .map(|account| account.identity.clone());
    });
    let Some(identity) = identity else {
        return;
    };
    let prompt: Vec<u16> = format!("{identity}\n\n이 계정을 풀에서 삭제할까요?")
        .encode_utf16()
        .chain(Some(0))
        .collect();
    if unsafe {
        MessageBoxW(
            hwnd,
            PCWSTR(prompt.as_ptr()),
            w!("계정 삭제"),
            MB_YESNO | MB_ICONWARNING | MB_DEFBUTTON2,
        )
    } != IDYES
    {
        return;
    }
    with_app(|app| {
        app.account_mutations.insert(control.id.clone());
        app.state.status = "계정 삭제 중…".into();
    });
    let hwnd_value = hwnd.0 as isize;
    thread::spawn(move || {
        let result = api::delete_account(&control.provider, &control.kind, &control.id);
        with_app(|app| {
            app.account_mutations.remove(&control.id);
            match result {
                Ok(()) => {
                    if let Some(pool) = app
                        .state
                        .pools
                        .iter_mut()
                        .find(|pool| pool.provider == control.provider)
                    {
                        pool.accounts.retain(|account| account.id != control.id);
                    }
                    app.rebuild_provider_views();
                    app.state.status = "계정을 삭제했습니다".into();
                    app.force_refresh.store(true, Ordering::Release);
                }
                Err(error) => app.state.status = format!("계정 삭제 실패: {error}"),
            }
        });
        unsafe {
            let _ = PostMessageW(HWND(hwnd_value as *mut _), WM_DATA, WPARAM(0), LPARAM(0));
        }
    });
}

fn launch_switch_action(hwnd: HWND, control: AccountSwitchControl) {
    let mut started = false;
    let mut identity = String::new();
    let mut needs_unpause = false;
    with_app(|app| {
        let key = account_switch_mutation_key(&control.provider, &control.id);
        if app.account_switch_mutations.contains(&key) {
            return;
        }
        app.account_switch_mutations.insert(key.clone());
        let previous = mark_active_account(&mut app.state.pools, &control.provider, &control.id);
        needs_unpause = (control.kind == "codex" || control.kind == "oauth")
            && app
                .state
                .pools
                .iter()
                .find(|pool| pool.provider == control.provider)
                .and_then(|pool| {
                    pool.accounts
                        .iter()
                        .find(|account| account.id == control.id)
                })
                .map(|account| account.paused)
                .unwrap_or(false);
        if needs_unpause {
            // Play on a paused row means "use this account again": clear the pause
            // locally so the row state flips before the refresh lands.
            if let Some(pool) = app
                .state
                .pools
                .iter_mut()
                .find(|pool| pool.provider == control.provider)
            {
                if let Some(account) = pool
                    .accounts
                    .iter_mut()
                    .find(|account| account.id == control.id)
                {
                    account.paused = false;
                }
            }
        }
        app.switch_previous_active.insert(key, previous);
        app.rebuild_provider_views();
        identity = app
            .state
            .pools
            .iter()
            .find(|pool| pool.provider == control.provider)
            .and_then(|pool| {
                pool.accounts
                    .iter()
                    .find(|account| account.id == control.id)
            })
            .map(|account| account.identity.clone())
            .unwrap_or_else(|| control.id.clone());
        app.state.status = format!("Switching to {identity}…");
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
        // The server refuses to activate a paused Codex/OAuth account (409), so unpause first.
        if needs_unpause {
            if control.kind == "oauth" {
                let _ = api::set_oauth_account_paused(&control.provider, &control.id, false);
            } else {
                let _ = api::set_codex_account_paused(&control.id, false);
            }
        }
        let result = api::set_active_account(&control.provider, &control.kind, &control.id);
        with_app(|app| {
            let key = account_switch_mutation_key(&control.provider, &control.id);
            app.account_switch_mutations.remove(&key);
            let previous = app.switch_previous_active.remove(&key).flatten();
            match result {
                Ok(()) => {
                    app.state.status = format!("Active: {identity}");
                    app.force_refresh.store(true, Ordering::Release);
                }
                Err(error) => {
                    if let Some(previous) = previous {
                        restore_active_account(&mut app.state.pools, &control.provider, &previous);
                        app.rebuild_provider_views();
                    }
                    app.state.status = error;
                }
            }
        });
        unsafe {
            let _ = PostMessageW(HWND(hwnd_value as *mut _), WM_DATA, WPARAM(0), LPARAM(0));
        }
    });
}

fn codex_auth_finished(status: &AuthStatusResponse) -> bool {
    status.done
        || matches!(
            status.status.as_deref(),
            Some("done" | "success" | "complete")
        )
}

fn oauth_auth_finished(status: &AuthStatusResponse) -> bool {
    status.done
}

fn cancel_codex_flow(flow_id: &str) -> Result<(), String> {
    api::cancel_login_flow(api::LoginFlow::Codex, Some(flow_id))
}

fn retry_codex_login_after_conflict<T>(
    mut start: impl FnMut() -> Result<T, String>,
    mut cancel: impl FnMut() -> Result<(), String>,
) -> Result<T, String> {
    match start() {
        Err(error) if api::is_http_status(&error, 409) => {
            cancel()?;
            start()
        }
        result => result,
    }
}

fn start_codex_reauth(control: &ReauthControl) -> Result<AuthFlowResponse, String> {
    let body = api::codex_login_body(Some(&control.id), true);
    retry_codex_login_after_conflict(
        || api::post_json("/api/codex-auth/login", &body),
        // Remote flows are flow-scoped and must never cancel another client's
        // attempt, so a blind provider-wide retry cancel is local-only.
        || {
            if api::is_remote() {
                Err("Another sign-in for this account is already in progress".into())
            } else {
                api::post_empty("/api/codex-auth/login/cancel", &serde_json::json!({}))
            }
        },
    )
}

fn cancel_codex_if_requested(cancel: &AuthCancellation) -> Result<(), String> {
    if !cancel.is_requested() {
        return Ok(());
    }
    let flow_id = cancel
        .flow_id()
        .ok_or_else(|| "인증 흐름이 시작되기 전에 취소가 요청되었습니다".to_string())?;
    cancel_codex_flow(&flow_id)?;
    Err("재인증이 취소되었습니다".into())
}

fn cancel_oauth_if_requested(cancel: &AuthCancellation, provider: &str) -> Result<(), String> {
    if !cancel.is_requested() {
        return Ok(());
    }
    cancel_oauth_flow(provider, cancel.flow_id().as_deref())?;
    Err("재인증이 취소되었습니다".into())
}

fn cancel_oauth_flow(provider: &str, flow_id: Option<&str>) -> Result<(), String> {
    api::cancel_login_flow(api::LoginFlow::Provider(provider), flow_id)
}

fn reauth_mutation_key(control: &ReauthControl) -> String {
    if control.provider == "openai" {
        format!("{}:{}", control.provider, control.id)
    } else {
        control.provider.clone()
    }
}

fn request_existing_reauth_cancel(
    mutations: &HashMap<String, Arc<AuthCancellation>>,
    key: &str,
) -> bool {
    let Some(existing) = mutations.get(key) else {
        return false;
    };
    existing.request();
    true
}

fn codex_login_status_path(flow_id: &str, account_id: Option<&str>, reauth: bool) -> String {
    let mut path = format!(
        "/api/codex-auth/login-status?flowId={}",
        api::encode_component(flow_id)
    );
    if let Some(account_id) = account_id {
        path.push_str("&accountId=");
        path.push_str(&api::encode_component(account_id));
    }
    if reauth {
        path.push_str("&reauth=1");
    }
    path
}

fn auth_poll_timeout(deadline: Instant) -> Option<i32> {
    let remaining = deadline.checked_duration_since(Instant::now())?;
    Some((remaining.as_millis() / 4).clamp(100, 10_000) as i32)
}

fn auth_failed(status: &AuthStatusResponse) -> Option<String> {
    let failed = status.status.as_deref().is_some_and(|value| {
        matches!(
            value.trim().to_ascii_lowercase().as_str(),
            "error"
                | "failed"
                | "failure"
                | "expired"
                | "cancelled"
                | "canceled"
                | "denied"
                | "rejected"
                | "timeout"
                | "timed_out"
        )
    });
    if failed {
        Some(
            status
                .error
                .clone()
                .or(status.message.clone())
                .unwrap_or_else(|| {
                    format!(
                        "인증 실패: {}",
                        status.status.as_deref().unwrap_or("failed")
                    )
                }),
        )
    } else {
        status.error.clone()
    }
}

fn launch_reauth(hwnd: HWND, control: ReauthControl) {
    if !api::valid_provider_name(&control.provider) {
        with_app(|app| app.state.status = "올바르지 않은 프로바이더 이름입니다".into());
        return;
    }
    let key = reauth_mutation_key(&control);
    let cancel = Arc::new(AuthCancellation::default());
    let mut started = false;
    let mut cancelled_existing = false;
    with_app(|app| {
        if request_existing_reauth_cancel(&app.reauth_mutations, &key) {
            app.state.status = "재인증을 취소하는 중...".into();
            cancelled_existing = true;
        } else {
            app.reauth_mutations.insert(key.clone(), cancel.clone());
            app.state.status = format!("{} 로그인 인증을 기다리는 중...", control.provider);
            started = true;
        }
    });
    if cancelled_existing {
        unsafe {
            let _ = InvalidateRect(hwnd, None, false);
        }
        return;
    }
    if !started {
        return;
    }
    let hwnd_value = hwnd.0 as isize;
    thread::spawn(move || {
        let deadline = Instant::now() + Duration::from_secs(300);
        let result = if control.provider == "openai" {
            let flow = start_codex_reauth(&control);
            flow.and_then(|flow| {
                let flow_id = flow
                    .flow_id
                    .clone()
                    .ok_or_else(|| "OCX가 인증 흐름을 시작하지 못했습니다".to_string())?;
                cancel.publish_flow_id(flow_id.clone());
                // Remote: bind the loopback listener, then open this PC's browser.
                let mut relay = start_client_browser_login(&flow, Some(&flow_id))?;
                cancel_codex_if_requested(&cancel)?;
                loop {
                    cancel_codex_if_requested(&cancel)?;
                    let remaining = deadline
                        .checked_duration_since(Instant::now())
                        .ok_or_else(|| "재인증 시간이 초과되었습니다".to_string())?;
                    wait_between_status_polls(
                        &mut relay,
                        api::LoginFlow::Codex,
                        Some(&flow_id),
                        remaining.min(Duration::from_secs(2)),
                    )?;
                    cancel_codex_if_requested(&cancel)?;
                    let timeout = auth_poll_timeout(deadline)
                        .ok_or_else(|| "재인증 시간이 초과되었습니다".to_string())?;
                    let path = codex_login_status_path(&flow_id, Some(&control.id), true);
                    let status: AuthStatusResponse = api::get_json(&path, timeout)?;
                    cancel_codex_if_requested(&cancel)?;
                    if let Some(error) = auth_failed(&status) {
                        return Err(error);
                    }
                    if codex_auth_finished(&status) {
                        return Ok(());
                    }
                }
            })
        } else {
            let started: Result<AuthFlowResponse, String> = api::post_json(
                "/api/oauth/login",
                &api::oauth_reauth_login_body(&control.provider, &control.id),
            );
            started.and_then(|flow| {
                if let Some(flow_id) = flow.flow_id.clone() {
                    cancel.publish_flow_id(flow_id);
                }
                let mut relay = start_client_browser_login(&flow, flow.flow_id.as_deref())?;
                let flow_id = flow.flow_id.clone();
                loop {
                    cancel_oauth_if_requested(&cancel, &control.provider)?;
                    let remaining = deadline
                        .checked_duration_since(Instant::now())
                        .ok_or_else(|| "재인증 시간이 초과되었습니다".to_string())?;
                    wait_between_status_polls(
                        &mut relay,
                        api::LoginFlow::Provider(&control.provider),
                        flow_id.as_deref(),
                        remaining.min(Duration::from_secs(2)),
                    )?;
                    cancel_oauth_if_requested(&cancel, &control.provider)?;
                    let timeout = auth_poll_timeout(deadline)
                        .ok_or_else(|| "재인증 시간이 초과되었습니다".to_string())?;
                    let path = api::oauth_status_path(&control.provider, flow_id.as_deref());
                    let status: AuthStatusResponse = api::get_json(&path, timeout)?;
                    cancel_oauth_if_requested(&cancel, &control.provider)?;
                    if let Some(error) = auth_failed(&status) {
                        return Err(error);
                    }
                    if oauth_auth_finished(&status) {
                        let config = ProviderConfig {
                            name: control.provider.clone(),
                            auth_mode: Some("oauth".into()),
                            disabled: false,
                        };
                        let pool = api::fetch_account_pool(&config);
                        let account = pool
                            .accounts
                            .iter()
                            .find(|account| account.id == control.id)
                            .ok_or_else(|| {
                                "로그인은 완료됐지만 OCX에서 대상 계정을 찾지 못했습니다"
                                    .to_string()
                            })?;
                        return if account.needs_reauth {
                            Err("로그인은 완료됐지만 이 계정은 여전히 재인증이 필요합니다".into())
                        } else {
                            Ok(())
                        };
                    }
                }
            })
        };
        with_app(|app| {
            let owns_slot = app
                .reauth_mutations
                .get(&key)
                .is_some_and(|active| Arc::ptr_eq(active, &cancel));
            if owns_slot {
                app.reauth_mutations.remove(&key);
                match result {
                    Ok(()) => {
                        app.state.status = "재인증이 완료되었습니다".into();
                        app.force_refresh.store(true, Ordering::Release);
                    }
                    Err(error) => app.state.status = error,
                }
            }
        });
        unsafe {
            let _ = PostMessageW(HWND(hwnd_value as *mut _), WM_DATA, WPARAM(0), LPARAM(0));
        }
    });
}

fn configured_preset(preset: &ProviderPreset, configs: &[ProviderConfig]) -> bool {
    preset.auth.eq_ignore_ascii_case("key")
        && provider_preset_action(preset) == ProviderPresetAction::ApiKey
        && configs.iter().any(|config| config.name == preset.id)
}

/// Configured API-key presets stay clickable: selecting one opens the key modal in
/// "add another key" mode so the user can grow the provider's key pool without
/// overwriting the existing provider row.
fn api_key_preset_adds_key(preset: &ProviderPreset, configs: &[ProviderConfig]) -> bool {
    configured_preset(preset, configs)
}

fn provider_catalog_tab(preset: &ProviderPreset) -> ProviderCatalogTab {
    match provider_preset_action(preset) {
        ProviderPresetAction::CodexAccount | ProviderPresetAction::OAuth(_) => {
            ProviderCatalogTab::Accounts
        }
        ProviderPresetAction::ApiKey
            if preset.free_tier
                || preset.key_optional
                || preset.auth.eq_ignore_ascii_case("local") =>
        {
            ProviderCatalogTab::Free
        }
        ProviderPresetAction::ApiKey | ProviderPresetAction::Unsupported => {
            ProviderCatalogTab::Paid
        }
    }
}

fn auth_detail_lines(details: &AuthFlowResponse) -> Vec<String> {
    let mut lines = Vec::new();
    if let Some(instructions) = details
        .instructions
        .as_deref()
        .map(str::trim)
        .filter(|value| !value.is_empty())
    {
        lines.push(instructions.to_string());
    }
    if let Some(device_code) = details
        .device_code
        .as_deref()
        .map(str::trim)
        .filter(|value| !value.is_empty())
    {
        lines.push(format!("Code: {device_code}"));
    }
    if let Some(url) = details
        .url
        .as_deref()
        .map(str::trim)
        .filter(|value| !value.is_empty())
    {
        lines.push(format!("URL: {url}"));
    }
    lines
}

// ShellExecuteW opens the user's default browser. The crate's `windows` feature
// set does not include Win32_UI_Shell, so the one entry point used here is
// declared directly instead of widening a dependency this worker does not own.
#[link(name = "shell32")]
extern "system" {
    fn ShellExecuteW(
        hwnd: *mut std::ffi::c_void,
        operation: *const u16,
        file: *const u16,
        parameters: *const u16,
        directory: *const u16,
        show: i32,
    ) -> *mut std::ffi::c_void;
}

/// True when a server-supplied authorization URL is safe to hand to the shell:
/// http/https only, no whitespace, control, quoting or non-ASCII characters, so
/// the string cannot become an argument to anything but the browser.
fn openable_authorization_url(url: &str) -> bool {
    let scheme_ok = ["https://", "http://"].iter().any(|scheme| {
        url.get(..scheme.len())
            .is_some_and(|head| head.eq_ignore_ascii_case(scheme))
    });
    scheme_ok
        && url.len() <= 4096
        && url.len() > 8
        && !url.chars().any(|ch| {
            ch.is_control() || ch.is_whitespace() || !ch.is_ascii() || matches!(ch, '"' | '\'')
        })
}

/// Open the authorization URL in this PC's default browser. Used only in remote
/// mode: a local OCX opens the browser itself, on the same machine.
fn open_authorization_url(url: &str) -> Result<(), String> {
    if !openable_authorization_url(url) {
        return Err("The server sent an authorization URL that cannot be opened".into());
    }
    let operation: Vec<u16> = "open\0".encode_utf16().collect();
    let file: Vec<u16> = url.encode_utf16().chain(Some(0)).collect();
    // SW_SHOWNORMAL(1). ShellExecuteW reports failure as an HINSTANCE <= 32.
    let result = unsafe {
        ShellExecuteW(
            std::ptr::null_mut(),
            operation.as_ptr(),
            file.as_ptr(),
            std::ptr::null(),
            std::ptr::null(),
            1,
        )
    };
    if (result as isize) <= 32 {
        return Err("Could not open the browser for sign-in".into());
    }
    Ok(())
}

/// Start the client half of a remote browser login.
///
/// The loopback listener is bound *before* the browser opens, so a fast redirect
/// cannot hit a closed port. A device-code flow carries no `callbackUri`; there
/// is nothing to receive locally, and the user confirms the code on the provider
/// page instead. Local mode returns `None`: the server owns both browser and
/// callback on this same machine.
fn start_client_browser_login(
    details: &AuthFlowResponse,
    flow_id: Option<&str>,
) -> Result<Option<CallbackRelay>, String> {
    if !api::is_remote() {
        return Ok(None);
    }
    let callback_uri = details
        .callback_uri
        .as_deref()
        .map(str::trim)
        .filter(|value| !value.is_empty());
    if callback_uri.is_some() && flow_id.is_none() {
        return Err("The server started a browser sign-in without a flow identifier".into());
    }
    let relay = match callback_uri {
        Some(uri) => Some(CallbackRelay::bind(uri)?),
        None => None,
    };
    if let Some(url) = details
        .url
        .as_deref()
        .map(str::trim)
        .filter(|value| !value.is_empty())
    {
        open_authorization_url(url)?;
    }
    Ok(relay)
}

/// Relay a captured callback to the flow that issued it, then close the port.
/// The relay is consumed once: a replayed redirect finds nothing listening.
fn relay_pending_callback(
    relay: &mut Option<CallbackRelay>,
    flow: api::LoginFlow<'_>,
    flow_id: &str,
) -> Result<(), String> {
    let Some(active) = relay.as_mut() else {
        return Ok(());
    };
    if let Some(callback_url) = active.try_callback()? {
        api::submit_login_callback(flow, flow_id, &callback_url)?;
        *relay = None;
    }
    Ok(())
}

/// Wait out one status-poll interval while staying responsive to the browser
/// redirect. Without a relay this is a plain sleep, preserving local timing.
fn wait_between_status_polls(
    relay: &mut Option<CallbackRelay>,
    flow: api::LoginFlow<'_>,
    flow_id: Option<&str>,
    interval: Duration,
) -> Result<(), String> {
    let deadline = Instant::now() + interval;
    if relay.is_none() {
        thread::sleep(interval);
        return Ok(());
    }
    let Some(flow_id) = flow_id else {
        thread::sleep(interval);
        return Ok(());
    };
    while Instant::now() < deadline {
        relay_pending_callback(relay, flow, flow_id)?;
        if relay.is_none() {
            break;
        }
        let remaining = deadline.saturating_duration_since(Instant::now());
        thread::sleep(remaining.min(Duration::from_millis(120)));
    }
    Ok(())
}

unsafe fn copy_to_clipboard(hwnd: HWND, text: &str) -> windows::core::Result<()> {
    let wide: Vec<u16> = text.encode_utf16().chain(std::iter::once(0)).collect();
    let memory = GlobalAlloc(GMEM_MOVEABLE, wide.len() * size_of::<u16>())?;
    let destination = GlobalLock(memory) as *mut u16;
    if destination.is_null() {
        let error = windows::core::Error::from_win32();
        let _ = GlobalFree(memory);
        return Err(error);
    }
    std::ptr::copy_nonoverlapping(wide.as_ptr(), destination, wide.len());
    let _ = GlobalUnlock(memory);
    if let Err(error) = OpenClipboard(hwnd) {
        let _ = GlobalFree(memory);
        return Err(error);
    }
    // CF_UNICODETEXT; ownership transfers to Windows only on success.
    let result = EmptyClipboard().and_then(|_| SetClipboardData(13, HANDLE(memory.0)));
    let _ = CloseClipboard();
    if result.is_err() {
        let _ = GlobalFree(memory);
    }
    result.map(|_| ())
}

unsafe fn destroy_api_key_edit(app: &mut App) {
    if let Some(edit) = app.api_key_edit.take() {
        let edit = HWND(edit as *mut _);
        let _ = SetWindowTextW(edit, w!(""));
        let _ = DestroyWindow(edit);
    }
    if let Some(edit) = app.account_id_edit.take() {
        let edit = HWND(edit as *mut _);
        let _ = SetWindowTextW(edit, w!(""));
        let _ = DestroyWindow(edit);
    }
    for edit in [app.kiro_start_url_edit.take(), app.kiro_region_edit.take()]
        .into_iter()
        .flatten()
    {
        let edit = HWND(edit as *mut _);
        let _ = SetWindowTextW(edit, w!(""));
        let _ = DestroyWindow(edit);
    }
    // The token field is cleared before the window dies so the credential does
    // not linger in an edit control's buffer.
    for edit in [
        app.connection_url_edit.take(),
        app.connection_token_edit.take(),
    ]
    .into_iter()
    .flatten()
    {
        let edit = HWND(edit as *mut _);
        let _ = SetWindowTextW(edit, w!(""));
        let _ = DestroyWindow(edit);
    }
}

fn api_key_edit_needs_cleanup(modal_open: bool, edit_present: bool) -> bool {
    !modal_open && edit_present
}

unsafe fn close_provider_modal(app: &mut App, cancel_oauth: bool) {
    if cancel_oauth {
        if let Some(ProviderModal::Picker {
            waiting_provider: Some(_),
            cancel: Some(cancel),
            error,
            ..
        }) = &mut app.provider_modal
        {
            cancel.request();
            *error = Some("인증을 취소하는 중...".into());
            return;
        }
    }
    destroy_api_key_edit(app);
    app.modal_generation = app.modal_generation.wrapping_add(1);
    app.provider_modal = None;
}

fn open_provider_modal(hwnd: HWND) {
    let mut generation = 0;
    with_app(|app| {
        app.expanded = true;
        app.modal_generation = app.modal_generation.wrapping_add(1);
        generation = app.modal_generation;
        app.provider_modal = Some(ProviderModal::Picker {
            presets: Vec::new(),
            loading: true,
            error: None,
            waiting_provider: None,
            waiting_codex: false,
            auth_details: None,
            url_copied_at: None,
            cancel: None,
            scroll: 0,
            selected_tab: ProviderCatalogTab::Free,
        });
    });
    unsafe {
        resize_for_state(hwnd);
        let _ = InvalidateRect(hwnd, None, false);
    }
    let hwnd_value = hwnd.0 as isize;
    thread::spawn(move || {
        let result = api::get_json::<ProviderPresetsResponse>("/api/provider-presets", 20_000);
        let configs = api::get_json::<Vec<ProviderConfig>>("/api/providers", 20_000);
        with_app(|app| {
            if app.modal_generation != generation {
                return;
            }
            if let Ok(configs) = configs {
                app.state.configs = configs;
            }
            if let Some(ProviderModal::Picker {
                presets,
                loading,
                error,
                ..
            }) = &mut app.provider_modal
            {
                *loading = false;
                match result {
                    Ok(mut value) => {
                        value.providers.retain(|preset| {
                            preset.id != "custom"
                                && provider_preset_action(preset)
                                    != ProviderPresetAction::Unsupported
                        });
                        *presets = value.providers;
                    }
                    Err(value) => *error = Some(value),
                }
            }
        });
        unsafe {
            let _ = PostMessageW(HWND(hwnd_value as *mut _), WM_DATA, WPARAM(0), LPARAM(0));
        }
    });
}

fn begin_oauth_preset(hwnd: HWND, provider: String, organization: Option<(String, String)>) {
    if !api::valid_provider_name(&provider) {
        with_app(|app| {
            if let Some(ProviderModal::Picker { error, .. }) = &mut app.provider_modal {
                *error = Some("Invalid provider name".into());
            }
        });
        return;
    }
    let cancel = Arc::new(AuthCancellation::default());
    let mut generation = 0;
    let mut started = false;
    with_app(|app| {
        if let Some(ProviderModal::Picker {
            waiting_provider,
            waiting_codex,
            auth_details,
            cancel: slot,
            error,
            ..
        }) = &mut app.provider_modal
        {
            if waiting_provider.is_none() {
                *waiting_provider = Some(provider.clone());
                *waiting_codex = false;
                *auth_details = None;
                *slot = Some(cancel.clone());
                *error = None;
                generation = app.modal_generation;
                started = true;
            }
        }
    });
    if !started {
        return;
    }
    let hwnd_value = hwnd.0 as isize;
    thread::spawn(move || {
        let deadline = Instant::now() + Duration::from_secs(300);
        // addAccount forces a fresh browser identity instead of re-importing the
        // current local CLI session, so "add account" really adds a new pool row.
        let flow: Result<AuthFlowResponse, String> = match organization.as_ref() {
            Some((start_url, region)) => api::start_oauth_account_login_with_kiro_organization(
                &provider,
                Some(api::KiroOrganizationLoginRequest { start_url, region }),
            ),
            None => api::start_oauth_account_login(&provider),
        };
        let result = flow.and_then(|flow| {
            with_app(|app| {
                if app.modal_generation == generation {
                    if let Some(ProviderModal::Picker { auth_details, .. }) =
                        &mut app.provider_modal
                    {
                        *auth_details = Some(flow.clone());
                    }
                }
            });
            unsafe {
                let _ = PostMessageW(HWND(hwnd_value as *mut _), WM_DATA, WPARAM(0), LPARAM(0));
            }
            let flow_id = flow.flow_id.clone();
            if let Some(flow_id) = flow_id.clone() {
                cancel.publish_flow_id(flow_id);
            }
            let mut relay = start_client_browser_login(&flow, flow_id.as_deref())?;
            cancel_oauth_if_requested(&cancel, &provider)?;
            loop {
                cancel_oauth_if_requested(&cancel, &provider)?;
                let Some(remaining) = deadline.checked_duration_since(Instant::now()) else {
                    let _ = cancel_oauth_flow(&provider, flow_id.as_deref());
                    return Err("Provider sign-in timed out".to_string());
                };
                wait_between_status_polls(
                    &mut relay,
                    api::LoginFlow::Provider(&provider),
                    flow_id.as_deref(),
                    remaining.min(Duration::from_secs(2)),
                )?;
                cancel_oauth_if_requested(&cancel, &provider)?;
                let Some(timeout) = auth_poll_timeout(deadline) else {
                    let _ = cancel_oauth_flow(&provider, flow_id.as_deref());
                    return Err("Provider sign-in timed out".to_string());
                };
                let status: AuthStatusResponse = api::get_json(
                    &api::oauth_status_path(&provider, flow_id.as_deref()),
                    timeout,
                )?;
                cancel_oauth_if_requested(&cancel, &provider)?;
                if let Some(error) = auth_failed(&status) {
                    return Err(error);
                }
                if oauth_auth_finished(&status) {
                    return if status.logged_in {
                        Ok(())
                    } else {
                        Err("Provider sign-in finished without a credential".into())
                    };
                }
            }
        });
        with_app(|app| {
            if app.modal_generation != generation {
                return;
            }
            match result {
                Ok(()) => {
                    app.provider_modal = None;
                    app.modal_generation = app.modal_generation.wrapping_add(1);
                    app.state.status = format!("Added {provider}");
                    app.force_refresh.store(true, Ordering::Release);
                }
                Err(error) => {
                    if let Some(ProviderModal::Picker {
                        waiting_provider,
                        waiting_codex,
                        auth_details,
                        cancel,
                        error: modal_error,
                        ..
                    }) = &mut app.provider_modal
                    {
                        *waiting_provider = None;
                        *waiting_codex = false;
                        *auth_details = None;
                        *cancel = None;
                        *modal_error = Some(error);
                    }
                }
            }
        });
        unsafe {
            let _ = PostMessageW(HWND(hwnd_value as *mut _), WM_DATA, WPARAM(0), LPARAM(0));
        }
    });
}

fn kiro_organization_request(start_url: &str, region: &str) -> Result<(String, String), String> {
    if start_url.len() > 2048
        || start_url.chars().any(char::is_control)
        || region.chars().any(char::is_control)
    {
        return Err("정식 AWS Start URL (*.awsapps.com/start)을 입력하세요.".into());
    }
    let start_url = start_url.trim();
    let region = region.trim();
    let authority_and_path = start_url.get(8..).filter(|_| {
        start_url
            .get(..8)
            .is_some_and(|scheme| scheme.eq_ignore_ascii_case("https://"))
    });
    let (authority, path) = authority_and_path
        .and_then(|value| value.split_once('/'))
        .unwrap_or_default();
    let host = authority.to_ascii_lowercase();
    let portal = host.strip_suffix(".awsapps.com").unwrap_or_default();
    let valid_portal = (1..=63).contains(&portal.len())
        && !portal.contains('.')
        && portal
            .bytes()
            .next()
            .is_some_and(|byte| byte.is_ascii_lowercase() || byte.is_ascii_digit())
        && portal
            .bytes()
            .last()
            .is_some_and(|byte| byte.is_ascii_lowercase() || byte.is_ascii_digit())
        && portal
            .bytes()
            .all(|byte| byte.is_ascii_lowercase() || byte.is_ascii_digit() || byte == b'-');
    let valid_host = valid_portal
        && authority.len() == host.len()
        && !authority.contains(['@', ':', '?', '#'])
        && matches!(path, "start" | "start/");
    if !valid_host {
        return Err("정식 AWS Start URL (*.awsapps.com/start)을 입력하세요.".into());
    }
    let region_parts: Vec<&str> = region.split('-').collect();
    let valid_region = region_parts.len() >= 3
        && region_parts[0].len() == 2
        && region_parts[0]
            .bytes()
            .all(|byte| byte.is_ascii_lowercase())
        && region_parts[1..region_parts.len() - 1]
            .iter()
            .all(|part| !part.is_empty() && part.bytes().all(|byte| byte.is_ascii_lowercase()))
        && region_parts
            .last()
            .is_some_and(|part| part.len() == 1 && part.bytes().all(|byte| byte.is_ascii_digit()));
    if !valid_region {
        return Err("AWS region을 입력하세요. 예: us-east-1".into());
    }
    Ok((format!("https://{host}/start"), region.to_string()))
}

fn prepare_kiro_auth_picker() {
    with_app(|app| {
        app.provider_modal = Some(ProviderModal::Picker {
            presets: Vec::new(),
            loading: false,
            error: None,
            waiting_provider: None,
            waiting_codex: false,
            auth_details: None,
            url_copied_at: None,
            cancel: None,
            scroll: 0,
            selected_tab: ProviderCatalogTab::Accounts,
        });
    });
}

/// True when a login, re-authentication, or account mutation is in flight.
///
/// Switching servers mid-flow would point the next request — including a
/// callback relay — at a different OCX than the one that issued the flow, so the
/// connection modal refuses to save while anything is outstanding.
fn connection_change_busy(app: &App) -> bool {
    let mutations = app.reauth_mutations.len()
        + app.account_mutations.len()
        + app.account_switch_mutations.len()
        + app.reset_credit_mutations.len();
    let login_waiting = matches!(
        &app.provider_modal,
        Some(ProviderModal::Picker {
            waiting_provider: Some(_),
            ..
        })
    );
    connection_change_blocked(mutations, login_waiting)
}

/// The rule behind [`connection_change_busy`]: any outstanding login or account
/// mutation blocks a connection change, because the next request would otherwise
/// reach a different server than the one that issued the flow.
fn connection_change_blocked(active_mutations: usize, login_waiting: bool) -> bool {
    active_mutations > 0 || login_waiting
}

/// Open the Local/Remote connection modal, pre-filled with the current mode and
/// address. The stored token is never read back into the UI: the vault is
/// write-only from here, so a remote edit always re-enters the credential.
unsafe fn show_connection_modal(hwnd: HWND) {
    let remote = api::is_remote();
    let base_url = api::connection_base_url();
    let busy = APP.get().is_some_and(|app| {
        let app = app.lock().unwrap_or_else(|poisoned| poisoned.into_inner());
        connection_change_busy(&app)
    });
    with_app(|app| {
        destroy_api_key_edit(app);
        app.expanded = true;
        app.modal_generation = app.modal_generation.wrapping_add(1);
        app.provider_modal = Some(ProviderModal::Connection {
            remote,
            submitting: false,
            error: busy.then(|| {
                "Finish or cancel the sign-in in progress before changing the connection"
                    .to_string()
            }),
        });
        if let Ok(instance) = GetModuleHandleW(None) {
            for (id, top, password, slot) in [
                (
                    CONNECTION_URL_EDIT_ID,
                    236,
                    false,
                    &mut app.connection_url_edit,
                ),
                (
                    CONNECTION_TOKEN_EDIT_ID,
                    316,
                    true,
                    &mut app.connection_token_edit,
                ),
            ] {
                if let Ok(edit) = CreateWindowExW(
                    WS_EX_CLIENTEDGE,
                    w!("EDIT"),
                    w!(""),
                    WINDOW_STYLE(
                        WS_CHILD.0
                            | WS_VISIBLE.0
                            | WS_TABSTOP.0
                            | ES_AUTOHSCROLL as u32
                            | if password { ES_PASSWORD as u32 } else { 0 },
                    ),
                    60,
                    top,
                    (app.width - 120).max(180),
                    30,
                    hwnd,
                    HMENU(id as *mut _),
                    instance,
                    None,
                ) {
                    if password {
                        let _ = SendMessageW(edit, 0x00CC, WPARAM('●' as usize), LPARAM(0));
                    }
                    *slot = Some(edit.0 as isize);
                }
            }
            if let Some(edit) = app.connection_url_edit {
                if remote {
                    let value: Vec<u16> = base_url.encode_utf16().chain(Some(0)).collect();
                    let _ = SetWindowTextW(HWND(edit as *mut _), PCWSTR(value.as_ptr()));
                }
                let _ = windows::Win32::UI::Input::KeyboardAndMouse::SetFocus(HWND(edit as *mut _));
            }
        }
    });
    resize_for_state(hwnd);
    let _ = InvalidateRect(hwnd, None, false);
}

/// Apply the edited connection. Local mode clears the stored profile; remote mode
/// validates and probes the address/credential inside `api::save_connection`, so
/// a rejected server or token leaves the previous connection in place.
unsafe fn submit_connection(hwnd: HWND) {
    let mut submission = None;
    with_app(|app| {
        if connection_change_busy(app) {
            if let Some(ProviderModal::Connection { error, .. }) = &mut app.provider_modal {
                *error = Some(
                    "Finish or cancel the sign-in in progress before changing the connection"
                        .into(),
                );
            }
            return;
        }
        let Some(ProviderModal::Connection {
            remote,
            submitting,
            error,
        }) = &mut app.provider_modal
        else {
            return;
        };
        if *submitting {
            return;
        }
        if !*remote {
            *submitting = true;
            *error = None;
            submission = Some((None, app.modal_generation));
            return;
        }
        let (Some(url_edit), Some(token_edit)) =
            (app.connection_url_edit, app.connection_token_edit)
        else {
            return;
        };
        let base_url = native_edit_text(url_edit);
        let token = native_edit_text(token_edit);
        if base_url.trim().is_empty() || token.trim().is_empty() {
            *error = Some("Enter the server address and the management token".into());
            return;
        }
        *submitting = true;
        *error = None;
        submission = Some((Some((base_url, token)), app.modal_generation));
    });
    let Some((remote, generation)) = submission else {
        return;
    };
    // The token leaves the edit control immediately; the worker thread owns the
    // only remaining copy until save_connection consumes it.
    with_app(|app| {
        if let Some(edit) = app.connection_token_edit {
            let _ = SetWindowTextW(HWND(edit as *mut _), w!(""));
        }
    });
    let hwnd_value = hwnd.0 as isize;
    thread::spawn(move || {
        let mut remote = remote;
        let result = match remote.as_mut() {
            Some((base_url, token)) => {
                let outcome = api::save_connection(Some(base_url), Some(token));
                token.as_bytes_mut().fill(0);
                outcome
            }
            None => api::save_connection(None, None),
        };
        drop(remote);
        with_app(|app| {
            match result {
                Ok(()) => {
                    app.state.remote = api::is_remote();
                    app.state.connection_error = api::connection_error();
                    // The previous server's data must not linger next to the new
                    // connection's status line.
                    app.state.pid = 0;
                    app.state.working_set = 0;
                    app.state.private_commit = 0;
                    app.state.system_memory = None;
                    app.state.details = None;
                    app.state.pools.clear();
                    app.state.providers.clear();
                    app.state.configs.clear();
                    app.state.quotas.clear();
                    app.state.usage.clear();
                    app.state.logs.clear();
                    app.state.status = if app.state.remote {
                        format!("Connected to {}", api::connection_base_url())
                    } else {
                        "Using the local OCX".into()
                    };
                    if app.modal_generation == generation {
                        destroy_api_key_edit(app);
                        app.provider_modal = None;
                        app.modal_generation = app.modal_generation.wrapping_add(1);
                    }
                    app.force_refresh.store(true, Ordering::Release);
                }
                Err(error) => {
                    if app.modal_generation == generation {
                        if let Some(ProviderModal::Connection {
                            submitting,
                            error: modal_error,
                            ..
                        }) = &mut app.provider_modal
                        {
                            *submitting = false;
                            *modal_error = Some(error);
                        }
                    }
                }
            }
        });
        unsafe {
            let _ = PostMessageW(HWND(hwnd_value as *mut _), WM_DATA, WPARAM(0), LPARAM(0));
        }
    });
}

unsafe fn show_kiro_account_choice(hwnd: HWND) {
    with_app(|app| {
        destroy_api_key_edit(app);
        app.modal_generation = app.modal_generation.wrapping_add(1);
        app.provider_modal = Some(ProviderModal::KiroAccountChoice);
    });
    resize_for_state(hwnd);
    let _ = InvalidateRect(hwnd, None, false);
}

unsafe fn show_kiro_organization(hwnd: HWND) {
    with_app(|app| {
        destroy_api_key_edit(app);
        app.modal_generation = app.modal_generation.wrapping_add(1);
        app.provider_modal = Some(ProviderModal::KiroOrganization { error: None });
        if let Ok(instance) = GetModuleHandleW(None) {
            for (id, top, slot) in [
                (KIRO_START_URL_EDIT_ID, 220, &mut app.kiro_start_url_edit),
                (KIRO_REGION_EDIT_ID, 300, &mut app.kiro_region_edit),
            ] {
                if let Ok(edit) = CreateWindowExW(
                    WS_EX_CLIENTEDGE,
                    w!("EDIT"),
                    w!(""),
                    WINDOW_STYLE(WS_CHILD.0 | WS_VISIBLE.0 | WS_TABSTOP.0 | ES_AUTOHSCROLL as u32),
                    60,
                    top,
                    (app.width - 120).max(180),
                    30,
                    hwnd,
                    HMENU(id as *mut _),
                    instance,
                    None,
                ) {
                    *slot = Some(edit.0 as isize);
                }
            }
            if let Some(edit) = app.kiro_start_url_edit {
                let _ = windows::Win32::UI::Input::KeyboardAndMouse::SetFocus(HWND(edit as *mut _));
            }
        }
    });
    resize_for_state(hwnd);
    let _ = InvalidateRect(hwnd, None, false);
}

unsafe fn native_edit_text(edit: isize) -> String {
    let edit = HWND(edit as *mut _);
    let length = GetWindowTextLengthW(edit).max(0) as usize;
    let mut buffer = vec![0u16; length + 1];
    let read = GetWindowTextW(edit, &mut buffer) as usize;
    let value = String::from_utf16_lossy(&buffer[..read]);
    buffer.fill(0);
    value
}

unsafe fn submit_kiro_organization(hwnd: HWND) {
    let mut request = None;
    with_app(|app| {
        let (Some(start_url), Some(region)) = (app.kiro_start_url_edit, app.kiro_region_edit)
        else {
            return;
        };
        match kiro_organization_request(&native_edit_text(start_url), &native_edit_text(region)) {
            Ok(value) => request = Some(value),
            Err(message) => {
                if let Some(ProviderModal::KiroOrganization { error }) = &mut app.provider_modal {
                    *error = Some(message);
                }
            }
        }
    });
    if let Some(request) = request {
        with_app(|app| destroy_api_key_edit(app));
        prepare_kiro_auth_picker();
        begin_oauth_preset(hwnd, "kiro".into(), Some(request));
    }
}

fn begin_codex_account(hwnd: HWND) {
    let cancel = Arc::new(AuthCancellation::default());
    let mut generation = 0;
    let mut started = false;
    with_app(|app| {
        if let Some(ProviderModal::Picker {
            waiting_provider,
            waiting_codex,
            auth_details,
            cancel: slot,
            error,
            ..
        }) = &mut app.provider_modal
        {
            if waiting_provider.is_none() {
                *waiting_provider = Some("OpenAI".into());
                *waiting_codex = true;
                *auth_details = None;
                *slot = Some(cancel.clone());
                *error = None;
                generation = app.modal_generation;
                started = true;
            }
        }
    });
    if !started {
        return;
    }
    unsafe {
        let _ = InvalidateRect(hwnd, None, false);
    }
    let hwnd_value = hwnd.0 as isize;
    thread::spawn(move || {
        let deadline = Instant::now() + Duration::from_secs(300);
        let flow: Result<AuthFlowResponse, String> =
            api::post_json("/api/codex-auth/login", &api::codex_login_body(None, false));
        let result = flow.and_then(|flow| {
            let flow_id = flow
                .flow_id
                .clone()
                .ok_or_else(|| "OCX did not return a Codex login flow id".to_string())?;
            cancel.publish_flow_id(flow_id.clone());
            with_app(|app| {
                if app.modal_generation == generation {
                    if let Some(ProviderModal::Picker { auth_details, .. }) =
                        &mut app.provider_modal
                    {
                        *auth_details = Some(flow.clone());
                    }
                }
            });
            unsafe {
                let _ = PostMessageW(HWND(hwnd_value as *mut _), WM_DATA, WPARAM(0), LPARAM(0));
            }
            let mut relay = start_client_browser_login(&flow, Some(&flow_id))?;
            cancel_codex_if_requested(&cancel)?;
            loop {
                cancel_codex_if_requested(&cancel)?;
                let remaining = deadline
                    .checked_duration_since(Instant::now())
                    .ok_or_else(|| "OpenAI account login timed out".to_string())?;
                wait_between_status_polls(
                    &mut relay,
                    api::LoginFlow::Codex,
                    Some(&flow_id),
                    remaining.min(Duration::from_secs(2)),
                )?;
                cancel_codex_if_requested(&cancel)?;
                let timeout = auth_poll_timeout(deadline)
                    .ok_or_else(|| "OpenAI account login timed out".to_string())?;
                let status: AuthStatusResponse =
                    api::get_json(&codex_login_status_path(&flow_id, None, false), timeout)?;
                cancel_codex_if_requested(&cancel)?;
                if let Some(error) = auth_failed(&status) {
                    return Err(error);
                }
                if codex_auth_finished(&status) {
                    return Ok(());
                }
            }
        });
        with_app(|app| {
            if app.modal_generation != generation {
                return;
            }
            match result {
                Ok(()) => {
                    app.provider_modal = None;
                    app.modal_generation = app.modal_generation.wrapping_add(1);
                    app.state.status = "Added OpenAI account".into();
                    app.force_refresh.store(true, Ordering::Release);
                }
                Err(error) => {
                    if let Some(ProviderModal::Picker {
                        waiting_provider,
                        waiting_codex,
                        auth_details,
                        cancel,
                        error: modal_error,
                        ..
                    }) = &mut app.provider_modal
                    {
                        *waiting_provider = None;
                        *waiting_codex = false;
                        *auth_details = None;
                        *cancel = None;
                        *modal_error = Some(error);
                    }
                }
            }
        });
        unsafe {
            let _ = PostMessageW(HWND(hwnd_value as *mut _), WM_DATA, WPARAM(0), LPARAM(0));
        }
    });
}

unsafe fn show_api_key_preset(hwnd: HWND, preset: ProviderPreset, add_key: bool) {
    with_app(|app| {
        destroy_api_key_edit(app);
        let needs_account_id = !add_key && supports_account_id_base_url(&preset);
        let local_auth = preset.auth.eq_ignore_ascii_case("local");
        app.modal_generation = app.modal_generation.wrapping_add(1);
        app.provider_modal = Some(ProviderModal::ApiKey {
            preset,
            submitting: false,
            error: None,
            add_key,
        });
        if let Ok(instance) = GetModuleHandleW(None) {
            if needs_account_id {
                if let Ok(edit) = CreateWindowExW(
                    WS_EX_CLIENTEDGE,
                    w!("EDIT"),
                    w!(""),
                    WINDOW_STYLE(WS_CHILD.0 | WS_VISIBLE.0 | WS_TABSTOP.0 | ES_AUTOHSCROLL as u32),
                    60,
                    254,
                    (app.width - 120).max(180),
                    30,
                    hwnd,
                    HMENU(ACCOUNT_ID_EDIT_ID as *mut _),
                    instance,
                    None,
                ) {
                    app.account_id_edit = Some(edit.0 as isize);
                }
            }
            let key_top = if needs_account_id { 318 } else { 238 };
            if let Ok(edit) = CreateWindowExW(
                WS_EX_CLIENTEDGE,
                w!("EDIT"),
                w!(""),
                WINDOW_STYLE(
                    WS_CHILD.0
                        | WS_VISIBLE.0
                        | WS_TABSTOP.0
                        | ES_AUTOHSCROLL as u32
                        | if local_auth { 0 } else { ES_PASSWORD as u32 },
                ),
                60,
                key_top,
                (app.width - 120).max(180),
                30,
                hwnd,
                HMENU(API_KEY_EDIT_ID as *mut _),
                instance,
                None,
            ) {
                let _ = SendMessageW(edit, 0x00CC, WPARAM('•' as usize), LPARAM(0));
                app.api_key_edit = Some(edit.0 as isize);
            }
            let focus = app
                .account_id_edit
                .or(app.api_key_edit)
                .map(|edit| HWND(edit as *mut _));
            if let Some(focus) = focus {
                let _ = windows::Win32::UI::Input::KeyboardAndMouse::SetFocus(focus);
            }
        }
    });
    resize_for_state(hwnd);
    let _ = InvalidateRect(hwnd, None, false);
}

unsafe fn submit_api_key(hwnd: HWND) {
    let mut submission = None;
    with_app(|app| {
        let Some(edit) = app.api_key_edit else {
            return;
        };
        let edit = HWND(edit as *mut _);
        let length = GetWindowTextLengthW(edit).max(0) as usize;
        let mut buffer = vec![0u16; length + 1];
        let read = GetWindowTextW(edit, &mut buffer) as usize;
        let key = String::from_utf16_lossy(&buffer[..read]);
        buffer.fill(0);
        let _ = SetWindowTextW(edit, w!(""));
        let account_id = if let Some(edit) = app.account_id_edit {
            let edit = HWND(edit as *mut _);
            let length = GetWindowTextLengthW(edit).max(0) as usize;
            let mut buffer = vec![0u16; length + 1];
            let read = GetWindowTextW(edit, &mut buffer) as usize;
            let account_id = String::from_utf16_lossy(&buffer[..read]);
            buffer.fill(0);
            let _ = SetWindowTextW(edit, w!(""));
            account_id
        } else {
            String::new()
        };
        let allow_empty_key = match &app.provider_modal {
            Some(ProviderModal::ApiKey {
                preset, add_key, ..
            }) => (preset.key_optional || preset.auth.eq_ignore_ascii_case("local")) && !*add_key,
            _ => false,
        };
        if key.trim().is_empty() && !allow_empty_key {
            if let Some(ProviderModal::ApiKey { error, .. }) = &mut app.provider_modal {
                *error = Some("Enter an API key".into());
            }
            return;
        }
        if let Some(ProviderModal::ApiKey {
            preset,
            submitting,
            error,
            add_key,
        }) = &mut app.provider_modal
        {
            if !*submitting {
                *submitting = true;
                *error = None;
                submission = Some((
                    preset.clone(),
                    key,
                    account_id,
                    app.modal_generation,
                    *add_key,
                ));
            }
        }
    });
    let Some((preset, mut key, mut account_id, generation, add_key)) = submission else {
        return;
    };
    let payload = if add_key {
        serde_json::json!({ "name": preset.id, "key": key })
    } else {
        let base_url = match resolve_provider_base_url(
            &preset,
            (!account_id.trim().is_empty()).then_some(account_id.as_str()),
        ) {
            Ok(base_url) => base_url,
            Err(error) => {
                key.as_bytes_mut().fill(0);
                account_id.clear();
                with_app(|app| {
                    if let Some(ProviderModal::ApiKey {
                        submitting,
                        error: modal_error,
                        ..
                    }) = &mut app.provider_modal
                    {
                        *submitting = false;
                        *modal_error = Some(error.into());
                    }
                });
                return;
            }
        };
        let api_key = (!key.trim().is_empty()).then_some(key.as_str());
        let create = match api_key {
            Some(api_key) if supports_account_id_base_url(&preset) => {
                provider_create_body_with_base_url(&preset, Some(api_key), &base_url)
            }
            Some(api_key) => provider_create_body(&preset, api_key),
            None if supports_account_id_base_url(&preset) => {
                provider_create_body_with_base_url(&preset, None, &base_url)
            }
            None => provider_create_body_with_api_key(&preset, None),
        };
        let create = match create {
            Ok(payload) => payload,
            Err(error) => {
                key.as_bytes_mut().fill(0);
                account_id.clear();
                with_app(|app| {
                    if let Some(ProviderModal::ApiKey {
                        submitting,
                        error: modal_error,
                        ..
                    }) = &mut app.provider_modal
                    {
                        *submitting = false;
                        *modal_error = Some(error.into());
                    }
                });
                return;
            }
        };
        match serde_json::to_value(create) {
            Ok(payload) => payload,
            Err(error) => {
                key.as_bytes_mut().fill(0);
                account_id.clear();
                with_app(|app| {
                    if let Some(ProviderModal::ApiKey {
                        submitting,
                        error: modal_error,
                        ..
                    }) = &mut app.provider_modal
                    {
                        *submitting = false;
                        *modal_error = Some(format!("Invalid provider request: {error}"));
                    }
                });
                return;
            }
        }
    };
    let body = match serde_json::to_vec(&payload) {
        Ok(body) => body,
        Err(error) => {
            key.as_bytes_mut().fill(0);
            account_id.clear();
            with_app(|app| {
                if let Some(ProviderModal::ApiKey {
                    submitting,
                    error: modal_error,
                    ..
                }) = &mut app.provider_modal
                {
                    *submitting = false;
                    *modal_error = Some(format!("Invalid provider request: {error}"));
                }
            });
            return;
        }
    };
    key.as_bytes_mut().fill(0);
    account_id.clear();
    let hwnd_value = hwnd.0 as isize;
    thread::spawn(move || {
        let mut body = body;
        let payload = payload;
        let result = if add_key {
            api::post_json::<serde_json::Value>("/api/providers/keys", &payload).map(|_| ())
        } else {
            api::post_raw("/api/providers", &body)
        };
        body.fill(0);
        drop(payload);
        with_app(|app| {
            if app.modal_generation != generation {
                return;
            }
            match result {
                Ok(()) => {
                    app.provider_modal = None;
                    app.modal_generation = app.modal_generation.wrapping_add(1);
                    app.state.status = if add_key {
                        format!("Added key to {}", preset.label)
                    } else {
                        format!("Added {}", preset.label)
                    };
                    app.force_refresh.store(true, Ordering::Release);
                }
                Err(value) => {
                    if let Some(ProviderModal::ApiKey {
                        submitting, error, ..
                    }) = &mut app.provider_modal
                    {
                        *submitting = false;
                        *error = Some(value);
                    }
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
            let mut context_menu_open = false;
            with_app(|app| {
                app.drain_updates();
                if api_key_edit_needs_cleanup(
                    app.provider_modal.is_some(),
                    app.api_key_edit.is_some() || app.connection_token_edit.is_some(),
                ) {
                    unsafe { destroy_api_key_edit(app) };
                }
                context_menu_open = app.context_menu_open;
            });
            // TrackPopupMenu runs a nested message loop. Raising the topmost owner while that
            // loop is active can put the notch in front of its own popup on Windows. Keep data
            // fresh, but defer owner-window movement and painting until the menu closes.
            if !context_menu_open {
                resize_for_state(hwnd);
                let _ = InvalidateRect(hwnd, None, false);
            }
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
                let cursor_id = if APP.get().is_some_and(|app| {
                    let app = app.lock().unwrap_or_else(|poisoned| poisoned.into_inner());
                    app.account_reauth_hits
                        .iter()
                        .any(|(hit, _)| point_in(hit, point.x, point.y))
                        || app
                            .account_reset_credit_hits
                            .iter()
                            .any(|(hit, _)| point_in(hit, point.x, point.y))
                }) {
                    IDC_HAND
                } else if point.x < RESIZE_EDGE || point.x >= rect.right - RESIZE_EDGE {
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
                if app.provider_modal.is_some() {
                    app.pressed_modal_hit = app
                        .modal_hits
                        .iter()
                        .find(|(rect, _)| point_in(rect, x, y))
                        .map(|(_, hit)| hit.clone());
                    app.drag_origin = None;
                    app.resize_origin = None;
                    button_down = app.pressed_modal_hit.is_some();
                    return;
                }
                app.power_hot = !app.state.remote && point_in(&power_hit_rect(app.width), x, y);
                app.minimize_hot = app.expanded && point_in(&minimize_hit_rect(app.width), x, y);
                let account_control = app
                    .account_pause_hits
                    .iter()
                    .find(|(rect, _)| point_in(rect, x, y))
                    .map(|(_, control)| control.clone());
                let account_switch = app
                    .account_switch_hits
                    .iter()
                    .find(|(rect, _)| point_in(rect, x, y))
                    .map(|(_, control)| control.clone());
                let account_delete = app
                    .account_delete_hits
                    .iter()
                    .find(|(rect, _)| point_in(rect, x, y))
                    .map(|(_, control)| control.clone());
                let reauth_control = app
                    .account_reauth_hits
                    .iter()
                    .find(|(rect, _)| point_in(rect, x, y))
                    .map(|(_, control)| control.clone());
                let reset_credit_control = app
                    .account_reset_credit_hits
                    .iter()
                    .find(|(rect, _)| point_in(rect, x, y))
                    .map(|(_, control)| control.clone());
                let model_hit = app
                    .model_hits
                    .iter()
                    .find(|(rect, _)| point_in(rect, x, y))
                    .map(|(_, hit)| hit.clone());
                let subagent_hit = app
                    .subagent_hits
                    .iter()
                    .find(|(rect, _)| point_in(rect, x, y))
                    .map(|(_, hit)| hit.clone());
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
                    app.pressed_account_switch = None;
                } else if let Some(control) = account_delete {
                    app.resize_origin = None;
                    app.pressed_button = None;
                    app.pressed_account_control = None;
                    app.pressed_account_switch = None;
                    app.pressed_account_delete = Some(control);
                    app.drag_origin = None;
                    app.drag_moved = false;
                    button_down = true;
                } else if let Some(control) = account_switch {
                    app.resize_origin = None;
                    app.pressed_button = None;
                    app.pressed_account_control = None;
                    app.pressed_account_switch = Some(control);
                    app.button_inside = false;
                    app.drag_origin = None;
                    app.drag_moved = false;
                    button_down = true;
                } else if let Some(control) = account_control {
                    app.resize_origin = None;
                    app.pressed_button = None;
                    app.pressed_account_switch = None;
                    app.pressed_account_control = Some(control);
                    app.button_inside = false;
                    app.drag_origin = None;
                    app.drag_moved = false;
                    button_down = true;
                } else if let Some(control) = reauth_control {
                    app.resize_origin = None;
                    app.pressed_button = None;
                    app.pressed_account_control = None;
                    app.pressed_account_switch = None;
                    app.pressed_reauth_control = Some(control);
                    app.button_inside = false;
                    app.drag_origin = None;
                    app.drag_moved = false;
                    button_down = true;
                } else if let Some(control) = reset_credit_control {
                    app.resize_origin = None;
                    app.pressed_button = None;
                    app.pressed_account_control = None;
                    app.pressed_account_switch = None;
                    app.pressed_reauth_control = None;
                    app.pressed_reset_credit_control = Some(control);
                    app.button_inside = false;
                    app.drag_origin = None;
                    app.drag_moved = false;
                    button_down = true;
                } else if let Some(hit) = model_hit {
                    app.resize_origin = None;
                    app.pressed_button = None;
                    app.pressed_model_hit = Some(hit);
                    app.button_inside = false;
                    app.drag_origin = None;
                    app.drag_moved = false;
                    button_down = true;
                } else if let Some(hit) = subagent_hit {
                    app.resize_origin = None;
                    app.pressed_button = None;
                    app.pressed_subagent_hit = Some(hit);
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
                    app.pressed_account_switch = None;
                    button_down = true;
                } else if app.minimize_hot {
                    app.pressed_button = Some(Button::Minimize);
                    app.button_inside = true;
                    app.drag_origin = None;
                    app.drag_moved = false;
                    app.pressed_account_control = None;
                    app.pressed_account_switch = None;
                    button_down = true;
                } else {
                    app.resize_origin = None;
                    app.pressed_button = None;
                    app.button_inside = false;
                    app.drag_origin = Some((cursor, window));
                    app.drag_moved = false;
                    app.pressed_account_control = None;
                    app.pressed_account_switch = None;
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
                if app.provider_modal.is_some() {
                    return;
                }
                let power_hot = !app.state.remote && point_in(&power_hit_rect(app.width), x, y);
                let minimize_hot = app.expanded && point_in(&minimize_hit_rect(app.width), x, y);
                let hot_account_control = app
                    .account_pause_hits
                    .iter()
                    .find(|(rect, _)| point_in(rect, x, y))
                    .map(|(_, control)| control.clone());
                let hot_account_switch = app
                    .account_switch_hits
                    .iter()
                    .find(|(rect, _)| point_in(rect, x, y))
                    .map(|(_, control)| control.clone());
                let hot_account_delete = app
                    .account_delete_hits
                    .iter()
                    .find(|(rect, _)| point_in(rect, x, y))
                    .map(|(_, control)| control.clone());
                let hot_reauth_control = app
                    .account_reauth_hits
                    .iter()
                    .find(|(rect, _)| point_in(rect, x, y))
                    .map(|(_, control)| control.clone());
                let hot_reset_credit_control = app
                    .account_reset_credit_hits
                    .iter()
                    .find(|(rect, _)| point_in(rect, x, y))
                    .map(|(_, control)| control.clone());
                let hot_tab = app
                    .expanded
                    .then(|| content_tab_at(app.width, x, y))
                    .flatten();
                if app.power_hot != power_hot
                    || app.minimize_hot != minimize_hot
                    || app.hot_account_control != hot_account_control
                    || app.hot_account_switch != hot_account_switch
                    || app.hot_account_delete != hot_account_delete
                    || app.hot_reauth_control != hot_reauth_control
                    || app.hot_reset_credit_control != hot_reset_credit_control
                    || app.hot_tab != hot_tab
                {
                    changed = true;
                }
                app.power_hot = power_hot;
                app.minimize_hot = minimize_hot;
                app.hot_account_control = hot_account_control;
                app.hot_account_switch = hot_account_switch;
                app.hot_account_delete = hot_account_delete;
                app.hot_reauth_control = hot_reauth_control;
                app.hot_reset_credit_control = hot_reset_credit_control;
                app.hot_tab = hot_tab;
                if let Some(button) = app.pressed_button {
                    let inside = match button {
                        Button::Power => power_hot,
                        Button::Minimize => minimize_hot,
                    };
                    if app.button_inside != inside {
                        changed = true;
                    }
                    app.button_inside = inside;
                } else if app.pressed_account_control.is_some()
                    || app.pressed_account_switch.is_some()
                    || app.pressed_account_delete.is_some()
                    || app.pressed_reauth_control.is_some()
                    || app.pressed_reset_credit_control.is_some()
                    || app.pressed_model_hit.is_some()
                    || app.pressed_subagent_hit.is_some()
                {
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
            let mut switch_action = None;
            let mut delete_action = None;
            let mut reauth_action = None;
            let mut reset_credit_action = None;
            let mut model_action = None;
            let mut subagent_action = None;
            let mut modal_action = None;
            with_app(|app| {
                was_drag = app.drag_moved;
                let pressed_button = app.pressed_button.take();
                let pressed_account_control = app.pressed_account_control.take();
                let pressed_account_switch = app.pressed_account_switch.take();
                let pressed_account_delete = app.pressed_account_delete.take();
                let pressed_reauth_control = app.pressed_reauth_control.take();
                let pressed_reset_credit_control = app.pressed_reset_credit_control.take();
                let pressed_model_hit = app.pressed_model_hit.take();
                let pressed_subagent_hit = app.pressed_subagent_hit.take();
                let pressed_modal_hit = app.pressed_modal_hit.take();
                let button_inside = app.button_inside;
                app.button_inside = false;
                app.drag_origin = None;
                app.resize_origin = None;
                app.drag_moved = false;
                if app.provider_modal.is_some() {
                    if let Some(pressed) = pressed_modal_hit {
                        let released_inside = app
                            .modal_hits
                            .iter()
                            .any(|(rect, hit)| *hit == pressed && point_in(rect, x, y));
                        if released_inside {
                            modal_action = Some(pressed);
                        }
                    }
                    handled_button = true;
                    return;
                }
                if let Some(hit) = pressed_model_hit {
                    if app
                        .model_hits
                        .iter()
                        .any(|(rect, candidate)| *candidate == hit && point_in(rect, x, y))
                    {
                        model_action = Some(hit);
                    }
                    handled_button = true;
                    return;
                }
                if let Some(hit) = pressed_subagent_hit {
                    if app
                        .subagent_hits
                        .iter()
                        .any(|(rect, candidate)| *candidate == hit && point_in(rect, x, y))
                    {
                        subagent_action = Some(hit);
                    }
                    handled_button = true;
                    return;
                }
                if let Some(control) = pressed_reauth_control {
                    if app
                        .account_reauth_hits
                        .iter()
                        .any(|(rect, hit)| *hit == control && point_in(rect, x, y))
                    {
                        reauth_action = Some(control);
                    }
                    handled_button = true;
                    return;
                }
                if let Some(control) = pressed_account_delete {
                    if app
                        .account_delete_hits
                        .iter()
                        .any(|(rect, hit)| *hit == control && point_in(rect, x, y))
                    {
                        delete_action = Some(control);
                    }
                    handled_button = true;
                    return;
                }
                if let Some(control) = pressed_reset_credit_control {
                    if app
                        .account_reset_credit_hits
                        .iter()
                        .any(|(rect, hit)| *hit == control && point_in(rect, x, y))
                    {
                        reset_credit_action = Some(control);
                    }
                    handled_button = true;
                    return;
                }
                if let Some(control) = pressed_account_switch {
                    handled_button = true;
                    changed = true;
                    let released_inside =
                        app.account_switch_hits.iter().any(|(rect, hit)| {
                            *hit == control
                                && point_in(rect, x, y)
                                && !app.account_switch_mutations.contains(
                                    &account_switch_mutation_key(&control.provider, &control.id),
                                )
                        });
                    if released_inside {
                        switch_action = Some(control);
                    }
                    return;
                }
                if let Some(control) = pressed_account_control {
                    handled_button = true;
                    changed = true;
                    let released_inside = app
                        .account_pause_hits
                        .iter()
                        .any(|(rect, hit)| hit.id == control.id && point_in(rect, x, y));
                    if released_inside && !app.account_mutations.contains(&control.id) {
                        pause_action = Some((control.clone(), !control.paused));
                    }
                    return;
                }
                if let Some(button) = pressed_button {
                    handled_button = true;
                    changed = true;
                    if button_inside {
                        match button {
                            // Remote mode has no power control; this arm cannot be
                            // reached from a hidden button, and the guard keeps it
                            // unreachable if the layout ever changes.
                            Button::Power if !app.power_pending && !app.state.remote => {
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
                                app.want_logs.store(false, Ordering::Relaxed);
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
                    app.want_logs
                        .store(app.content_tab == ContentTab::Logs, Ordering::Relaxed);
                    changed = true;
                } else if let Some(tab) = content_tab_at(app.width, x, y) {
                    if app.content_tab != tab {
                        app.content_tab = tab;
                        app.scroll_offset = 0;
                        app.want_logs
                            .store(tab == ContentTab::Logs, Ordering::Relaxed);
                        if matches!(
                            tab,
                            ContentTab::Logs | ContentTab::Models | ContentTab::Subagents
                        ) {
                            app.force_refresh.store(true, Ordering::Relaxed);
                        }
                        changed = true;
                    }
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
            if let Some((control, paused)) = pause_action {
                launch_pause_action(hwnd, control, paused);
            }
            if let Some(control) = switch_action {
                launch_switch_action(hwnd, control);
            }
            if let Some(control) = delete_action {
                launch_delete_action(hwnd, control);
            }
            if let Some(control) = reauth_action {
                launch_reauth(hwnd, control);
            }
            if let Some(control) = reset_credit_action {
                open_reset_credit_modal(hwnd, control);
            }
            if let Some(action) = model_action {
                match action {
                    ModelHit::ToggleProvider(provider) => {
                        with_app(|app| {
                            if !app.expanded_model_providers.remove(&provider) {
                                app.expanded_model_providers.insert(provider);
                            }
                        });
                        resize_for_state(hwnd);
                        let _ = InvalidateRect(hwnd, None, false);
                    }
                    action => handle_model_action(hwnd, action),
                }
            }
            if let Some(action) = subagent_action {
                handle_subagent_action(hwnd, action);
            }
            if let Some(action) = modal_action {
                match action {
                    ModalHit::Cancel => with_app(|app| unsafe { close_provider_modal(app, true) }),
                    ModalHit::CopyAuthUrl => with_app(|app| {
                        if let Some(ProviderModal::Picker {
                            auth_details: Some(details),
                            url_copied_at,
                            error,
                            ..
                        }) = &mut app.provider_modal
                        {
                            if let Some(url) = details
                                .url
                                .as_deref()
                                .map(str::trim)
                                .filter(|url| !url.is_empty())
                            {
                                match unsafe { copy_to_clipboard(hwnd, url) } {
                                    Ok(()) => *url_copied_at = Some(Instant::now()),
                                    Err(_) => {
                                        *error = Some(
                                            "URL을 복사하지 못했습니다. 다시 눌러주세요.".into(),
                                        )
                                    }
                                }
                            }
                        }
                    }),
                    ModalHit::AddKey => unsafe { submit_api_key(hwnd) },
                    ModalHit::KiroPersonal => {
                        prepare_kiro_auth_picker();
                        begin_oauth_preset(hwnd, "kiro".into(), None);
                    }
                    ModalHit::KiroOrganization => unsafe { show_kiro_organization(hwnd) },
                    ModalHit::KiroOrganizationSubmit => unsafe { submit_kiro_organization(hwnd) },
                    ModalHit::ConnectionModeLocal | ModalHit::ConnectionModeRemote => {
                        let want_remote = action == ModalHit::ConnectionModeRemote;
                        with_app(|app| {
                            if let Some(ProviderModal::Connection {
                                remote,
                                submitting,
                                error,
                            }) = &mut app.provider_modal
                            {
                                if !*submitting {
                                    *remote = want_remote;
                                    *error = None;
                                }
                            }
                        });
                    }
                    ModalHit::ConnectionSave => unsafe { submit_connection(hwnd) },
                    ModalHit::ResetCreditUse => with_app(|app| {
                        if let Some(ProviderModal::ResetCredits {
                            loading,
                            confirming,
                            submitting,
                            control,
                            ..
                        }) = &mut app.provider_modal
                        {
                            if !*loading && !*submitting && control.available > 0 {
                                *confirming = true;
                            }
                        }
                    }),
                    ModalHit::ResetCreditConfirmCancel => with_app(|app| {
                        if let Some(ProviderModal::ResetCredits { confirming, .. }) =
                            &mut app.provider_modal
                        {
                            *confirming = false;
                        }
                    }),
                    ModalHit::ResetCreditConfirm => submit_reset_credit(hwnd),
                    ModalHit::Tab(tab) => with_app(|app| {
                        if let Some(ProviderModal::Picker {
                            selected_tab,
                            scroll,
                            error,
                            waiting_provider,
                            ..
                        }) = &mut app.provider_modal
                        {
                            if waiting_provider.is_none() {
                                *selected_tab = tab;
                                *scroll = 0;
                                *error = None;
                            }
                        }
                    }),
                    ModalHit::Preset(index) => {
                        let selection = APP.get().and_then(|app| {
                            let app = app.lock().unwrap_or_else(|poisoned| poisoned.into_inner());
                            match &app.provider_modal {
                                Some(ProviderModal::Picker { presets, .. }) => {
                                    presets.get(index).cloned().map(|preset| {
                                        let add_key =
                                            api_key_preset_adds_key(&preset, &app.state.configs);
                                        (preset, add_key)
                                    })
                                }
                                _ => None,
                            }
                        });
                        if let Some((preset, add_key)) = selection {
                            match provider_preset_action(&preset) {
                                ProviderPresetAction::CodexAccount => begin_codex_account(hwnd),
                                ProviderPresetAction::OAuth(provider) if provider == "kiro" => unsafe {
                                    show_kiro_account_choice(hwnd)
                                },
                                ProviderPresetAction::OAuth(provider) => {
                                    begin_oauth_preset(hwnd, provider, None)
                                }
                                ProviderPresetAction::ApiKey => unsafe {
                                    show_api_key_preset(hwnd, preset, add_key)
                                },
                                ProviderPresetAction::Unsupported => {}
                            }
                        }
                    }
                }
                resize_for_state(hwnd);
                let _ = InvalidateRect(hwnd, None, false);
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
                app.pressed_account_switch = None;
                app.pressed_account_delete = None;
                app.pressed_reauth_control = None;
                app.pressed_reset_credit_control = None;
                app.pressed_model_hit = None;
                app.pressed_subagent_hit = None;
                app.pressed_modal_hit = None;
                app.button_inside = false;
            });
            LRESULT(0)
        }
        WM_MOUSEWHEEL => {
            let delta = ((wparam.0 >> 16) as i16) as i32;
            with_app(|app| {
                if let Some(ProviderModal::Picker {
                    scroll,
                    presets,
                    selected_tab,
                    ..
                }) = &mut app.provider_modal
                {
                    let count = presets
                        .iter()
                        .filter(|preset| provider_catalog_tab(preset) == *selected_tab)
                        .count() as i32;
                    *scroll = (*scroll - delta.signum() * 64).clamp(0, (count * 54 - 300).max(0));
                } else if app.provider_modal.is_none() && app.expanded {
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
            } else if command == MENU_PROVIDER_ADD {
                open_provider_modal(hwnd);
            } else if command == MENU_CONNECTION {
                show_connection_modal(hwnd);
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
                if app.provider_modal.is_some() {
                    unsafe { close_provider_modal(app, true) };
                } else {
                    app.expanded = false;
                    app.scroll_offset = 0;
                    app.want_details.store(false, Ordering::Relaxed);
                    app.want_logs.store(false, Ordering::Relaxed);
                }
            });
            resize_for_state(hwnd);
            let _ = InvalidateRect(hwnd, None, false);
            LRESULT(0)
        }
        WM_DISPLAYCHANGE => {
            recover_window_after_display_change(hwnd);
            LRESULT(0)
        }
        WM_DESTROY => {
            with_app(|app| destroy_api_key_edit(app));
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
    if memory_dc.is_invalid() {
        draw_frame(dc, width, height);
        let _ = EndPaint(hwnd, &paint);
        return;
    }
    let bitmap = CreateCompatibleBitmap(dc, width, height);
    if bitmap.is_invalid() {
        let _ = DeleteDC(memory_dc);
        draw_frame(dc, width, height);
        let _ = EndPaint(hwnd, &paint);
        return;
    }
    let old_bitmap = SelectObject(memory_dc, bitmap);
    draw_frame(memory_dc, width, height);
    let _ = BitBlt(dc, 0, 0, width, height, memory_dc, 0, 0, SRCCOPY);
    let _ = SelectObject(memory_dc, old_bitmap);
    let _ = DeleteObject(bitmap);
    let _ = DeleteDC(memory_dc);
    let _ = EndPaint(hwnd, &paint);
}

unsafe fn draw_frame(dc: HDC, width: i32, height: i32) {
    let client = RECT {
        left: 0,
        top: 0,
        right: width,
        bottom: height,
    };
    let background = CreateSolidBrush(COLORREF(0x00211b18));
    let _ = FillRect(dc, &client, background);
    let _ = DeleteObject(background);
    let _ = SetBkMode(dc, TRANSPARENT);

    with_app(|app| draw_app(dc, width, height, app));
}

unsafe fn draw_app(dc: HDC, width: i32, height: i32, app: &mut App) {
    app.provider_hits.clear();
    app.account_pause_hits.clear();
    app.account_switch_hits.clear();
    app.account_delete_hits.clear();
    app.account_reauth_hits.clear();
    app.account_reset_credit_hits.clear();
    app.model_hits.clear();
    app.subagent_hits.clear();
    app.modal_hits.clear();
    let body_font = make_font(14, 500);
    let small_font = make_font(12, 400);
    let old_font = SelectObject(dc, body_font);
    if app.provider_modal.is_some() {
        draw_provider_modal(dc, width, height, app, body_font, small_font);
        let _ = SelectObject(dc, old_font);
        let _ = DeleteObject(body_font);
        let _ = DeleteObject(small_font);
        return;
    }
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
    // Remote mode owns no local process: Start/Stop is not drawn and not hit-tested.
    if !app.state.remote {
        draw_power_control(dc, width, app);
    }
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
    } else if let Some(error) = &app.state.connection_error {
        // A stored remote profile that cannot be used: say so instead of showing
        // local numbers under a remote header.
        format!("원격 연결 불가 · {error}")
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
        draw_content_tabs(dc, width, app, small_font);
        let mut y = CONTENT_TOP - app.scroll_offset;
        let _ = IntersectClipRect(dc, 0, CONTENT_TOP, width, height);
        if app.content_tab == ContentTab::Logs {
            draw_log_list(dc, width, height, app, body_font, small_font);
            let _ = SelectClipRgn(dc, None);
            let _ = SelectObject(dc, old_font);
            let _ = DeleteObject(body_font);
            let _ = DeleteObject(small_font);
            return;
        }
        if app.content_tab == ContentTab::Models {
            draw_models(dc, width, height, app, body_font, small_font);
            let _ = SelectClipRgn(dc, None);
            let _ = SelectObject(dc, old_font);
            let _ = DeleteObject(body_font);
            let _ = DeleteObject(small_font);
            return;
        }
        if app.content_tab == ContentTab::Subagents {
            draw_subagents(dc, width, height, app, body_font, small_font);
            let _ = SelectClipRgn(dc, None);
            let _ = SelectObject(dc, old_font);
            let _ = DeleteObject(body_font);
            let _ = DeleteObject(small_font);
            return;
        }

        let providers = ordered_provider_views(&app.state.providers);
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
            let header_label = if app.expanded_providers.contains(&provider.name) {
                provider_base_label(&provider)
            } else {
                provider_header_label(&provider)
            };
            draw_text(
                dc,
                &format!("{marker} {header_label}"),
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
            let columns = quota_columns(provider.quota.as_ref());
            if columns.is_empty() {
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
                draw_quota_columns(
                    dc,
                    &columns,
                    38,
                    width - 18,
                    y + 31,
                    small_font,
                    app.state.auto_switch_threshold,
                );
            }
            y += provider_height;
            if app.expanded_providers.contains(&provider.name) {
                let pool_size = provider.accounts.len();
                for account in provider.accounts {
                    let account_height = account_height(&account);
                    let reauth = reauth_eligible(&provider.name, &account);
                    let reauth_rect = reauth_action_rect(width, y);
                    if !account.is_main && account.id != "__main__" {
                        let rect = RECT {
                            left: width - 62,
                            top: y,
                            right: width - 14,
                            bottom: y + 30,
                        };
                        let control = AccountSwitchControl {
                            provider: provider.name.clone(),
                            id: account.id.clone(),
                            kind: account.kind.clone(),
                        };
                        let busy = app.account_mutations.contains(&account.id);
                        set_text_color(
                            dc,
                            if busy {
                                0x008e949e
                            } else if app.hot_account_delete.as_ref() == Some(&control) {
                                0x008888ff
                            } else {
                                0x009ba3d9
                            },
                        );
                        draw_text(dc, "삭제", rect, DT_CENTER | DT_SINGLELINE | DT_VCENTER);
                        if !busy && rect.top >= CONTENT_TOP && rect.bottom <= height {
                            app.account_delete_hits.push((rect, control));
                        }
                    }
                    let reset_credits = reset_credit_count(&account);
                    let identity_width = measure_text_width(dc, &account.identity);
                    let action_rect =
                        account_action_rect(width, y, identity_width, reset_credits.is_some());
                    let reset_credit_rect = reset_credit_action_rect(action_rect);
                    // One control per pool row: the ACTIVE account shows pause, every
                    // other account shows play ("make this account active"). OAuth pools
                    // (kiro/anthropic/xai) get the same controls as the Codex/API-key pools.
                    let show_action_control =
                        provider.name == "openai" || pool_size > 1 || account.kind == "oauth";
                    let pause_busy = app.account_mutations.contains(&account.id);
                    let switch_busy = app
                        .account_switch_mutations
                        .contains(&account_switch_mutation_key(&provider.name, &account.id));
                    set_text_color(dc, 0x00c7cbd2);
                    let identity_right = if show_action_control {
                        action_rect.left - ACCOUNT_ACTION_GAP
                    } else if reauth {
                        reauth_rect.left - ACCOUNT_ACTION_GAP
                    } else {
                        width - 250
                    };
                    draw_text(
                        dc,
                        &account.identity,
                        RECT {
                            left: ACCOUNT_IDENTITY_LEFT,
                            top: y,
                            right: identity_right,
                            bottom: y + 30,
                        },
                        DT_LEFT | DT_SINGLELINE | DT_VCENTER | DT_END_ELLIPSIS,
                    );
                    if show_action_control {
                        if account.active {
                            // Pause: this account is the one currently in use. Codex and
                            // OAuth (kiro/anthropic/xai) pool accounts can be paused
                            // (excluded from selection); API-key rows show the same state
                            // indicator without a pause API.
                            let control = AccountControl {
                                provider: provider.name.clone(),
                                kind: account.kind.clone(),
                                id: account.id.clone(),
                                paused: false,
                            };
                            let hot =
                                !pause_busy && app.hot_account_control.as_ref() == Some(&control);
                            let pressed = app.pressed_account_control.as_ref() == Some(&control);
                            draw_account_pause_control(dc, action_rect, hot, pressed, pause_busy);
                            if (provider.name == "openai" || account.kind == "oauth")
                                && !pause_busy
                                && action_rect.bottom > 101
                                && action_rect.top < height
                            {
                                app.account_pause_hits.push((action_rect, control));
                            }
                        } else {
                            // Play: make this account/key active.
                            let control = AccountSwitchControl {
                                provider: provider.name.clone(),
                                id: account.id.clone(),
                                kind: account.kind.clone(),
                            };
                            let hot =
                                !switch_busy && app.hot_account_switch.as_ref() == Some(&control);
                            let pressed = app.pressed_account_switch.as_ref() == Some(&control);
                            draw_account_play_control(dc, action_rect, hot, pressed, switch_busy);
                            if !switch_busy && action_rect.bottom > 101 && action_rect.top < height
                            {
                                app.account_switch_hits.push((action_rect, control));
                            }
                        }
                    }
                    if let Some(available) = reset_credits {
                        let control = ResetCreditControl {
                            id: account.id.clone(),
                            identity: account.identity.clone(),
                            available,
                        };
                        let busy = app.reset_credit_mutations.contains(&account.id);
                        let hot = !busy && app.hot_reset_credit_control.as_ref() == Some(&control);
                        let pressed = app.pressed_reset_credit_control.as_ref() == Some(&control);
                        draw_reset_credit_control(
                            dc,
                            reset_credit_rect,
                            available,
                            hot,
                            pressed,
                            busy,
                            body_font,
                        );
                        if !busy
                            && reset_credit_rect.bottom > CONTENT_TOP
                            && reset_credit_rect.top < height
                        {
                            app.account_reset_credit_hits
                                .push((reset_credit_rect, control));
                        }
                    }
                    if provider.name == "openai" {
                        if reauth {
                            let control = ReauthControl {
                                provider: provider.name.clone(),
                                id: account.id.clone(),
                            };
                            let waiting = app
                                .reauth_mutations
                                .contains_key(&reauth_mutation_key(&control));
                            set_text_color(dc, reauth_text_color(waiting));
                            draw_text(
                                dc,
                                if waiting {
                                    "인증 대기 중 · 취소"
                                } else {
                                    "재인증"
                                },
                                reauth_rect,
                                DT_RIGHT | DT_SINGLELINE | DT_VCENTER | DT_END_ELLIPSIS,
                            );
                            app.account_reauth_hits.push((reauth_rect, control));
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
                    let health = if reauth {
                        suffix.to_string()
                    } else {
                        format!("{}{}", account.health, suffix)
                    };
                    draw_text(
                        dc,
                        &health,
                        RECT {
                            left: width - 244,
                            top: y,
                            right: width - 18,
                            bottom: y + 30,
                        },
                        DT_RIGHT | DT_SINGLELINE | DT_VCENTER | DT_END_ELLIPSIS,
                    );
                    let columns = quota_columns(account.quota.as_ref());
                    draw_quota_columns(
                        dc,
                        &columns,
                        58,
                        width - 18,
                        y + 29,
                        small_font,
                        app.state.auto_switch_threshold,
                    );
                    y += account_height;
                }
            }
        }
        let _ = SelectClipRgn(dc, None);
    }
    let _ = SelectObject(dc, old_font);
    let _ = DeleteObject(body_font);
    let _ = DeleteObject(small_font);
}

fn content_tab_rect(tab: ContentTab) -> RECT {
    let left = match tab {
        ContentTab::Providers => 14,
        ContentTab::Logs => 86,
        ContentTab::Models => 158,
        ContentTab::Subagents => 230,
    };
    RECT {
        left,
        top: 58,
        right: left + 72,
        bottom: CONTENT_TOP,
    }
}

fn content_tab_at(width: i32, x: i32, y: i32) -> Option<ContentTab> {
    if x >= width - 14 {
        return None;
    }
    [
        ContentTab::Providers,
        ContentTab::Logs,
        ContentTab::Models,
        ContentTab::Subagents,
    ]
    .into_iter()
    .find(|tab| point_in(&content_tab_rect(*tab), x, y))
}

unsafe fn draw_content_tabs(dc: HDC, width: i32, app: &App, font: HFONT) {
    let _ = SelectObject(dc, font);
    for (tab, label) in [
        (ContentTab::Providers, "프로바이더"),
        (ContentTab::Logs, "로그"),
        (ContentTab::Models, "Models"),
        (ContentTab::Subagents, "Subagents"),
    ] {
        let rect = content_tab_rect(tab);
        let selected = app.content_tab == tab;
        let hot = app.hot_tab == Some(tab);
        if hot && !selected {
            fill_solid(
                dc,
                RECT {
                    left: rect.left + 4,
                    top: rect.top + 6,
                    right: rect.right - 4,
                    bottom: rect.bottom - 5,
                },
                0x002a2420,
            );
        }
        set_text_color(
            dc,
            if selected {
                0x00f0ece8
            } else if hot {
                0x00c7cbd2
            } else {
                0x008e949e
            },
        );
        draw_text(
            dc,
            label,
            RECT {
                left: rect.left + 6,
                top: rect.top + 3,
                right: rect.right - 6,
                bottom: rect.bottom - 3,
            },
            DT_CENTER | DT_SINGLELINE | DT_VCENTER | DT_END_ELLIPSIS,
        );
        if selected {
            fill_solid(
                dc,
                RECT {
                    left: rect.left + 18,
                    top: rect.bottom - 3,
                    right: rect.right - 18,
                    bottom: rect.bottom,
                },
                0x009dcb4e,
            );
        }
    }
    if width >= 520 {
        let details = app.state.details.as_ref();
        let summary = format!(
            "{}PID {}{}  ·  Rotate {}",
            if app.state.remote {
                format!("{}  ·  ", api::connection_base_url())
            } else {
                String::new()
            },
            app.state.pid,
            details
                .and_then(|value| value.heap_used)
                .map(|heap| format!("  ·  Heap {}", format_bytes(heap)))
                .unwrap_or_default(),
            if app.state.auto_switch_threshold == 0 {
                "off".into()
            } else {
                format!("{}%", app.state.auto_switch_threshold)
            },
        );
        set_text_color(dc, 0x007f858e);
        draw_text(
            dc,
            &summary,
            RECT {
                left: 322,
                top: 61,
                right: width - 18,
                bottom: CONTENT_TOP - 2,
            },
            DT_RIGHT | DT_SINGLELINE | DT_VCENTER | DT_END_ELLIPSIS,
        );
    }
    fill_solid(
        dc,
        RECT {
            left: 14,
            top: CONTENT_TOP - 1,
            right: width - 14,
            bottom: CONTENT_TOP,
        },
        0x003a322d,
    );
}

fn handle_model_action(hwnd: HWND, action: ModelHit) {
    let mut mutation = None;
    with_app(|app| {
        let (provider, rows, enabled) = match &action {
            ModelHit::SetModelVisibility {
                provider,
                id,
                native,
                enabled,
            } => {
                let Some(row) = app
                    .state
                    .models
                    .rows
                    .iter()
                    .find(|row| row.provider == *provider && row.id == *id && row.native == *native)
                    .cloned()
                else {
                    return;
                };
                (provider.clone(), vec![row], *enabled)
            }
            ModelHit::SetProviderVisibility { provider, enabled } => {
                let rows = app
                    .state
                    .models
                    .rows
                    .iter()
                    .filter(|row| row.provider == *provider)
                    .cloned()
                    .collect::<Vec<_>>();
                if rows.is_empty() {
                    return;
                }
                (provider.clone(), rows, *enabled)
            }
            ModelHit::ToggleProvider(_) => return,
        };
        let keys = rows
            .iter()
            .map(|row| ModelsState::mutation_key(&row.provider, &row.id, row.native))
            .collect::<Vec<_>>();
        if keys
            .iter()
            .any(|key| app.state.models.mutating.contains(key))
        {
            return;
        }
        app.state.models.mutating.extend(keys.iter().cloned());
        app.state.models.message = None;
        mutation = Some((provider, rows, keys, enabled));
    });
    let Some((provider, requested_rows, keys, enabled)) = mutation else {
        return;
    };
    let mutation_label = if requested_rows.len() == 1 {
        format!("/{}", requested_rows[0].id)
    } else {
        format!(" ({} models)", requested_rows.len())
    };
    unsafe {
        let _ = InvalidateRect(hwnd, None, false);
    }
    let hwnd_value = hwnd.0 as isize;
    thread::spawn(move || {
        let mut visibility_changed = false;
        let result: Result<(Vec<ModelRow>, SelectedModelsResponse), String> = (|| {
            let request = provider_visibility_request(&provider, &requested_rows, enabled);
            let _: serde_json::Value = api::put_json("/api/model-visibility", &request)?;
            visibility_changed = true;
            let rows = api::get_json("/api/models", 30_000)?;
            let selected = api::get_json("/api/selected-models", 30_000)?;
            Ok((rows, selected))
        })();
        with_app(|app| {
            for key in &keys {
                app.state.models.mutating.remove(key);
            }
            match result {
                Ok((rows, selected)) => {
                    app.state.models.apply_rows(rows);
                    app.state.models.apply_selected(selected);
                    app.state.models.message = Some(format!(
                        "{} {}{}",
                        if enabled { "Enabled" } else { "Hidden" },
                        provider,
                        mutation_label
                    ));
                }
                Err(error) => {
                    app.state.models.message = Some(format!("Update failed: {error}"));
                }
            }
        });
        unsafe {
            let _ = PostMessageW(HWND(hwnd_value as *mut _), WM_DATA, WPARAM(0), LPARAM(0));
        }
        if visibility_changed {
            // Do not queue this behind provider quota/account polling. The
            // server owns the catalog; reload it even if the Models read failed.
            let refreshed = (|| {
                let models = api::get_json("/api/subagent-models", 30_000)?;
                let injection = api::get_json("/api/injection-model", 30_000)?;
                Ok::<_, String>((models, injection))
            })();
            with_app(|app| match refreshed {
                Ok((models, injection)) => app.state.subagents.refresh(models, injection),
                Err(error) => {
                    app.state.subagents.message = Some(format!("Refresh failed: {error}"))
                }
            });
            unsafe {
                let _ = PostMessageW(HWND(hwnd_value as *mut _), WM_DATA, WPARAM(0), LPARAM(0));
            }
        }
    });
}

fn provider_visibility(state: &ModelsState, provider: &str) -> ProviderVisibility {
    let mut visible = 0;
    let mut total = 0;
    for row in state.rows.iter().filter(|row| row.provider == provider) {
        total += 1;
        if state.visible(row) {
            visible += 1;
        }
    }
    match (visible, total) {
        (0, _) => ProviderVisibility::AllOff,
        (visible, total) if visible == total => ProviderVisibility::AllOn,
        _ => ProviderVisibility::Mixed,
    }
}

fn provider_visibility_request<'a>(
    provider: &'a str,
    rows: &'a [ModelRow],
    enabled: bool,
) -> ModelVisibilityRequest<'a> {
    if let [row] = rows {
        return ModelsState::request(row, enabled);
    }
    ModelVisibilityRequest {
        scope: "models",
        provider,
        targets: rows
            .iter()
            .map(|row| VisibilityTarget {
                id: &row.id,
                native: row.native,
            })
            .collect(),
        enabled,
    }
}

fn models_content_height(state: &ModelsState, expanded: &HashSet<String>) -> i32 {
    if !state.loaded() {
        return 100;
    }
    if state.rows.is_empty() {
        return 120;
    }
    let provider_count = state
        .rows
        .iter()
        .map(|row| row.provider.as_str())
        .collect::<HashSet<_>>()
        .len() as i32;
    let visible_rows = state
        .rows
        .iter()
        .filter(|row| expanded.contains(&row.provider))
        .count() as i32;
    44 + provider_count * 34 + visible_rows * 38 + if state.message.is_some() { 34 } else { 0 }
}

unsafe fn draw_models(
    dc: HDC,
    width: i32,
    height: i32,
    app: &mut App,
    body_font: HFONT,
    small_font: HFONT,
) {
    let state = &app.state.models;
    let mut y = CONTENT_TOP - app.scroll_offset;
    let left = 18;
    let right = width - 18;
    let visible = |rect: &RECT| rect.bottom > CONTENT_TOP && rect.top < height;

    if !state.loaded() {
        let _ = SelectObject(dc, body_font);
        set_text_color(dc, 0x008e949e);
        draw_text(
            dc,
            state
                .message
                .as_deref()
                .unwrap_or("Loading model catalog..."),
            RECT {
                left,
                top: y + 20,
                right,
                bottom: y + 70,
            },
            DT_CENTER | DT_SINGLELINE | DT_VCENTER | DT_END_ELLIPSIS,
        );
        return;
    }

    let _ = SelectObject(dc, small_font);
    set_text_color(dc, 0x008e949e);
    draw_text(
        dc,
        "Visible models appear in the OCX and Codex catalog",
        RECT {
            left,
            top: y + 4,
            right,
            bottom: y + 36,
        },
        DT_LEFT | DT_SINGLELINE | DT_VCENTER | DT_END_ELLIPSIS,
    );
    y += 44;

    if state.rows.is_empty() {
        let _ = SelectObject(dc, body_font);
        set_text_color(dc, 0x008e949e);
        draw_text(
            dc,
            "No models are available from configured providers",
            RECT {
                left,
                top: y + 10,
                right,
                bottom: y + 62,
            },
            DT_CENTER | DT_SINGLELINE | DT_VCENTER | DT_END_ELLIPSIS,
        );
        return;
    }

    let mut provider = "";
    for row in &state.rows {
        if row.provider != provider {
            provider = &row.provider;
            let expanded = app.expanded_model_providers.contains(provider);
            let aggregate = provider_visibility(state, provider);
            let busy = state
                .rows
                .iter()
                .filter(|candidate| candidate.provider == provider)
                .any(|candidate| {
                    state.mutating.contains(&ModelsState::mutation_key(
                        &candidate.provider,
                        &candidate.id,
                        candidate.native,
                    ))
                });
            let heading = RECT {
                left,
                top: y,
                right: right - 76,
                bottom: y + 34,
            };
            if visible(&heading) {
                let _ = SelectObject(dc, body_font);
                set_text_color(dc, 0x00f0ece8);
                draw_text(
                    dc,
                    if expanded { "▾" } else { "▸" },
                    RECT {
                        left: heading.left,
                        right: heading.left + 20,
                        ..heading
                    },
                    DT_LEFT | DT_SINGLELINE | DT_VCENTER | DT_END_ELLIPSIS,
                );
                draw_text(
                    dc,
                    provider,
                    RECT {
                        left: heading.left + 20,
                        right: heading.right,
                        ..heading
                    },
                    DT_LEFT | DT_SINGLELINE | DT_VCENTER | DT_END_ELLIPSIS,
                );
                app.model_hits
                    .push((heading, ModelHit::ToggleProvider(provider.to_string())));

                let toggle = RECT {
                    left: right - 68,
                    top: heading.top + 3,
                    right,
                    bottom: heading.bottom - 3,
                };
                let (label, selected, enabled) = if busy {
                    ("Saving...", false, false)
                } else {
                    match aggregate {
                        ProviderVisibility::AllOn => ("On", true, true),
                        ProviderVisibility::AllOff => ("Off", false, true),
                        ProviderVisibility::Mixed => ("Mixed", false, true),
                    }
                };
                draw_subagent_button(dc, toggle, label, enabled, selected, small_font);
                if !busy {
                    app.model_hits.push((
                        toggle,
                        ModelHit::SetProviderVisibility {
                            provider: provider.to_string(),
                            enabled: aggregate != ProviderVisibility::AllOn,
                        },
                    ));
                }
            }
            y += 34;
        }

        if !app.expanded_model_providers.contains(provider) {
            continue;
        }

        let row_rect = RECT {
            left,
            top: y + 2,
            right,
            bottom: y + 34,
        };
        if visible(&row_rect) {
            fill_solid(dc, row_rect, 0x0027201d);
            let enabled = state.visible(row);
            let key = ModelsState::mutation_key(&row.provider, &row.id, row.native);
            let busy = state.mutating.contains(&key);
            let label = row
                .display_name
                .as_deref()
                .filter(|label| !label.trim().is_empty())
                .unwrap_or(&row.id);
            let _ = SelectObject(dc, small_font);
            set_text_color(dc, 0x00c7cbd2);
            draw_text(
                dc,
                label,
                RECT {
                    left: left + 8,
                    top: row_rect.top,
                    right: right - 76,
                    bottom: row_rect.bottom,
                },
                DT_LEFT | DT_SINGLELINE | DT_VCENTER | DT_END_ELLIPSIS,
            );
            let toggle = RECT {
                left: right - 68,
                top: row_rect.top + 2,
                right,
                bottom: row_rect.bottom - 2,
            };
            draw_subagent_button(
                dc,
                toggle,
                if busy {
                    "Saving..."
                } else if enabled {
                    "On"
                } else {
                    "Off"
                },
                !busy,
                enabled,
                small_font,
            );
            if !busy {
                app.model_hits.push((
                    toggle,
                    ModelHit::SetModelVisibility {
                        provider: row.provider.clone(),
                        id: row.id.clone(),
                        native: row.native,
                        enabled: !enabled,
                    },
                ));
            }
        }
        y += 38;
    }

    if let Some(message) = &state.message {
        let message_rect = RECT {
            left,
            top: y,
            right,
            bottom: y + 34,
        };
        if visible(&message_rect) {
            set_text_color(
                dc,
                if message.starts_with("Update failed") {
                    0x008888ff
                } else {
                    0x008edbc0
                },
            );
            draw_text(
                dc,
                message,
                message_rect,
                DT_LEFT | DT_SINGLELINE | DT_VCENTER | DT_END_ELLIPSIS,
            );
        }
    }
}

fn handle_subagent_action(hwnd: HWND, action: SubagentHit) {
    let mut save = None;
    with_app(|app| {
        if app.state.subagents.saving {
            return;
        }
        match action {
            SubagentHit::ToggleFeatured(model) => {
                app.state.subagents.toggle_featured(&model);
            }
            SubagentHit::MoveFeatured(index, direction) => {
                app.state.subagents.move_featured(index, direction);
            }
            SubagentHit::CycleModel => app.state.subagents.cycle_model(),
            SubagentHit::CycleEffort => app.state.subagents.cycle_effort(),
            SubagentHit::ToggleGuidance => app.state.subagents.toggle_guidance(),
            SubagentHit::ToggleSyncDefaults => app.state.subagents.toggle_sync_defaults(),
            SubagentHit::Save if app.state.subagents.dirty => {
                app.state.subagents.saving = true;
                app.state.subagents.message = None;
                save = Some((
                    app.state.subagents.chosen.clone(),
                    app.state.subagents.injection_request(),
                ));
            }
            SubagentHit::Save => {}
        }
    });
    unsafe {
        resize_for_state(hwnd);
        let _ = InvalidateRect(hwnd, None, false);
    }
    let Some((chosen, injection)) = save else {
        return;
    };
    let hwnd_value = hwnd.0 as isize;
    thread::spawn(move || {
        let result: Result<(SubagentModelsResponse, InjectionModelResponse), String> = (|| {
            let _: serde_json::Value = api::put_json(
                "/api/subagent-models",
                &SubagentModelsRequest { models: &chosen },
            )?;
            let _: serde_json::Value = api::put_json("/api/injection-model", &injection)?;
            let models = api::get_json("/api/subagent-models", 30_000)?;
            let injection = api::get_json("/api/injection-model", 30_000)?;
            Ok((models, injection))
        })();
        // Keep edited values on failure so a partial two-endpoint save can be
        // retried and converge both server settings on the same selection.
        with_app(|app| match result {
            Ok((models, injection)) => {
                app.state.subagents.apply_models(models);
                app.state.subagents.apply_injection(injection);
                app.state.subagents.mark_saved();
            }
            Err(error) => {
                app.state.subagents.saving = false;
                app.state.subagents.dirty = true;
                app.state.subagents.message = Some(format!("Save failed: {error}"));
            }
        });
        unsafe {
            let _ = PostMessageW(HWND(hwnd_value as *mut _), WM_DATA, WPARAM(0), LPARAM(0));
        }
    });
}

fn subagent_content_height(state: &SubagentState) -> i32 {
    if !state.loaded() {
        return 100;
    }
    let available = state
        .available
        .iter()
        .filter(|model| !state.chosen.contains(model))
        .count() as i32;
    64 + state.chosen.len() as i32 * 38
        + 34
        + available * 34
        + 234
        + if state.message.is_some() { 34 } else { 0 }
}

fn subagent_setting_rect(width: i32, top: i32) -> RECT {
    RECT {
        left: (width / 2).max(174),
        top: top + 5,
        right: width - 18,
        bottom: top + 35,
    }
}

unsafe fn draw_subagent_button(
    dc: HDC,
    rect: RECT,
    label: &str,
    enabled: bool,
    selected: bool,
    font: HFONT,
) {
    fill_solid(dc, rect, if selected { 0x00443824 } else { 0x002d2723 });
    let _ = SelectObject(dc, font);
    set_text_color(dc, if enabled { 0x00e2ded9 } else { 0x006f7380 });
    draw_text(
        dc,
        label,
        RECT {
            left: rect.left + 6,
            top: rect.top,
            right: rect.right - 6,
            bottom: rect.bottom,
        },
        DT_CENTER | DT_SINGLELINE | DT_VCENTER | DT_END_ELLIPSIS,
    );
}

unsafe fn draw_subagents(
    dc: HDC,
    width: i32,
    height: i32,
    app: &mut App,
    body_font: HFONT,
    small_font: HFONT,
) {
    let state = &app.state.subagents;
    let mut y = CONTENT_TOP - app.scroll_offset;
    let left = 18;
    let right = width - 18;
    let visible = |rect: &RECT| rect.bottom > CONTENT_TOP && rect.top < height;

    if !state.loaded() {
        let _ = SelectObject(dc, body_font);
        set_text_color(dc, 0x008e949e);
        draw_text(
            dc,
            state
                .message
                .as_deref()
                .unwrap_or("Loading subagent settings..."),
            RECT {
                left,
                top: y + 20,
                right,
                bottom: y + 70,
            },
            DT_CENTER | DT_SINGLELINE | DT_VCENTER | DT_END_ELLIPSIS,
        );
        return;
    }

    let _ = SelectObject(dc, body_font);
    set_text_color(dc, 0x00f0ece8);
    draw_text(
        dc,
        "Featured models",
        RECT {
            left,
            top: y + 8,
            right: right - 70,
            bottom: y + 36,
        },
        DT_LEFT | DT_SINGLELINE | DT_VCENTER,
    );
    let _ = SelectObject(dc, small_font);
    set_text_color(dc, 0x008edbc0);
    draw_text(
        dc,
        &format!("{}/{}", state.chosen.len(), subagents::FEATURED_MAX),
        RECT {
            left: right - 70,
            top: y + 8,
            right,
            bottom: y + 36,
        },
        DT_RIGHT | DT_SINGLELINE | DT_VCENTER,
    );
    y += 42;

    if state.chosen.is_empty() {
        set_text_color(dc, 0x008e949e);
        draw_text(
            dc,
            "No featured models selected",
            RECT {
                left: left + 20,
                top: y,
                right,
                bottom: y + 30,
            },
            DT_LEFT | DT_SINGLELINE | DT_VCENTER,
        );
        y += 38;
    } else {
        for (index, model) in state.chosen.iter().enumerate() {
            let row = RECT {
                left,
                top: y + 2,
                right,
                bottom: y + 34,
            };
            if visible(&row) {
                fill_solid(dc, row, 0x0027201d);
                let _ = SelectObject(dc, small_font);
                set_text_color(dc, 0x00c7cbd2);
                draw_text(
                    dc,
                    &format!("{}. {}", index + 1, model),
                    RECT {
                        left: left + 8,
                        top: row.top,
                        right: right - 92,
                        bottom: row.bottom,
                    },
                    DT_LEFT | DT_SINGLELINE | DT_VCENTER | DT_END_ELLIPSIS,
                );
                for (label, rect, action, enabled) in [
                    (
                        "Up",
                        RECT {
                            left: right - 90,
                            top: row.top,
                            right: right - 62,
                            bottom: row.bottom,
                        },
                        SubagentHit::MoveFeatured(index, -1),
                        index > 0,
                    ),
                    (
                        "Dn",
                        RECT {
                            left: right - 60,
                            top: row.top,
                            right: right - 32,
                            bottom: row.bottom,
                        },
                        SubagentHit::MoveFeatured(index, 1),
                        index + 1 < state.chosen.len(),
                    ),
                    (
                        "X",
                        RECT {
                            left: right - 30,
                            top: row.top,
                            right,
                            bottom: row.bottom,
                        },
                        SubagentHit::ToggleFeatured(model.clone()),
                        true,
                    ),
                ] {
                    draw_subagent_button(dc, rect, label, enabled, false, small_font);
                    if enabled {
                        app.subagent_hits.push((rect, action));
                    }
                }
            }
            y += 38;
        }
    }

    let _ = SelectObject(dc, small_font);
    set_text_color(dc, 0x008e949e);
    draw_text(
        dc,
        "Available models - click to feature",
        RECT {
            left,
            top: y,
            right,
            bottom: y + 30,
        },
        DT_LEFT | DT_SINGLELINE | DT_VCENTER,
    );
    y += 34;
    let full = state.chosen.len() >= subagents::FEATURED_MAX;
    for model in state
        .available
        .iter()
        .filter(|model| !state.chosen.contains(model))
    {
        let row = RECT {
            left,
            top: y + 2,
            right,
            bottom: y + 32,
        };
        if visible(&row) {
            draw_subagent_button(dc, row, model, !full, false, small_font);
            if !full {
                app.subagent_hits
                    .push((row, SubagentHit::ToggleFeatured(model.clone())));
            }
        }
        y += 34;
    }

    y += 8;
    let _ = SelectObject(dc, body_font);
    set_text_color(dc, 0x00f0ece8);
    draw_text(
        dc,
        "Delegation",
        RECT {
            left,
            top: y,
            right,
            bottom: y + 32,
        },
        DT_LEFT | DT_SINGLELINE | DT_VCENTER,
    );
    y += 34;

    for (label, value, action, enabled, selected) in [
        (
            "Preferred model",
            state.model.as_deref().unwrap_or("Automatic"),
            SubagentHit::CycleModel,
            !state.delegation_available.is_empty(),
            state.model.is_some(),
        ),
        (
            "Reasoning effort",
            state.effort.as_deref().unwrap_or("Automatic"),
            SubagentHit::CycleEffort,
            state.model.is_some() && !state.efforts.is_empty(),
            state.effort.is_some(),
        ),
        (
            "Multi-agent guidance",
            if state.guidance_enabled { "On" } else { "Off" },
            SubagentHit::ToggleGuidance,
            true,
            state.guidance_enabled,
        ),
        (
            "Sync Codex defaults",
            if state.sync_codex_defaults {
                "On"
            } else {
                "Off"
            },
            SubagentHit::ToggleSyncDefaults,
            state.model.is_some(),
            state.sync_codex_defaults,
        ),
    ] {
        let row = RECT {
            left,
            top: y,
            right,
            bottom: y + 42,
        };
        let control = subagent_setting_rect(width, y);
        if visible(&row) {
            let _ = SelectObject(dc, small_font);
            set_text_color(dc, if enabled { 0x00c7cbd2 } else { 0x006f7380 });
            draw_text(
                dc,
                label,
                RECT {
                    left,
                    top: y,
                    right: control.left - 8,
                    bottom: y + 42,
                },
                DT_LEFT | DT_SINGLELINE | DT_VCENTER | DT_END_ELLIPSIS,
            );
            draw_subagent_button(dc, control, value, enabled, selected, small_font);
            if enabled {
                app.subagent_hits.push((control, action));
            }
        }
        y += 42;
    }

    let save = RECT {
        left: (right - 120).max(left),
        top: y + 6,
        right,
        bottom: y + 40,
    };
    let save_enabled = state.dirty && !state.saving;
    if visible(&save) {
        draw_subagent_button(
            dc,
            save,
            if state.saving {
                "Saving..."
            } else {
                "Save changes"
            },
            save_enabled,
            state.dirty,
            body_font,
        );
        if save_enabled {
            app.subagent_hits.push((save, SubagentHit::Save));
        }
    }
    if let Some(message) = &state.message {
        set_text_color(dc, if state.dirty { 0x008888ff } else { 0x008edbc0 });
        draw_text(
            dc,
            message,
            RECT {
                left,
                top: y + 6,
                right: save.left - 8,
                bottom: y + 40,
            },
            DT_LEFT | DT_SINGLELINE | DT_VCENTER | DT_END_ELLIPSIS,
        );
    }
}

unsafe fn draw_log_list(
    dc: HDC,
    width: i32,
    height: i32,
    app: &App,
    body_font: HFONT,
    small_font: HFONT,
) {
    if app.state.logs.is_empty() {
        let message = if app.state.logs_error.is_some() {
            "로그를 불러오지 못했습니다"
        } else {
            "아직 표시할 로그가 없습니다"
        };
        let _ = SelectObject(dc, body_font);
        set_text_color(dc, 0x008e949e);
        draw_text(
            dc,
            message,
            RECT {
                left: 18,
                top: CONTENT_TOP,
                right: width - 18,
                bottom: CONTENT_TOP + EMPTY_LOG_HEIGHT,
            },
            DT_CENTER | DT_SINGLELINE | DT_VCENTER | DT_END_ELLIPSIS,
        );
        return;
    }

    let mut y = CONTENT_TOP - app.scroll_offset;
    for log in &app.state.logs {
        let bottom = y + LOG_ROW_HEIGHT;
        if bottom > CONTENT_TOP && y < height {
            let route = match (log.provider.is_empty(), log.display_model().is_empty()) {
                (false, false) => format!("{}  ·  {}", log.provider, log.display_model()),
                (false, true) => log.provider.clone(),
                (true, false) => log.display_model().to_string(),
                (true, true) => "알 수 없는 요청".into(),
            };
            let status = if log.status == 0 {
                "—".into()
            } else {
                log.status.to_string()
            };
            let tok_per_second = log
                .display_metrics
                .as_ref()
                .and_then(|metrics| metrics.tok_per_second.as_ref());
            let summary = format!("{}  {}", status, format_tok_per_second(tok_per_second));
            let mut metadata = vec![format_log_age(log.timestamp)];
            metadata.push(format!(
                "추론 {}",
                log.requested_effort.as_deref().unwrap_or("—")
            ));
            metadata.push(match log.fast_state() {
                Some(true) => "Fast ON".into(),
                Some(false) => "Fast OFF".into(),
                None => "Fast —".into(),
            });
            if let Some(tokens) = log.total_tokens {
                metadata.push(format!("{} 토큰", format_tokens(tokens)));
            }
            if log.usage_status.as_deref() == Some("estimated") {
                metadata.push("추정".into());
            }
            if let Some(error) = log.error_code.as_deref().filter(|value| !value.is_empty()) {
                metadata.push(error.to_string());
            }

            let _ = SelectObject(dc, body_font);
            set_text_color(dc, 0x00f0ece8);
            draw_text(
                dc,
                &route,
                RECT {
                    left: 18,
                    top: y + 1,
                    right: width - 126,
                    bottom: y + 24,
                },
                DT_LEFT | DT_SINGLELINE | DT_VCENTER | DT_END_ELLIPSIS,
            );
            set_text_color(dc, log_status_color(log.status));
            draw_text(
                dc,
                &summary,
                RECT {
                    left: width - 122,
                    top: y + 1,
                    right: width - 18,
                    bottom: y + 24,
                },
                DT_RIGHT | DT_SINGLELINE | DT_VCENTER | DT_END_ELLIPSIS,
            );
            let _ = SelectObject(dc, small_font);
            set_text_color(dc, 0x008e949e);
            draw_text(
                dc,
                &metadata.join("  ·  "),
                RECT {
                    left: 18,
                    top: y + 21,
                    right: width - 18,
                    bottom: bottom - 2,
                },
                DT_LEFT | DT_SINGLELINE | DT_VCENTER | DT_END_ELLIPSIS,
            );
            fill_solid(
                dc,
                RECT {
                    left: 18,
                    top: bottom - 1,
                    right: width - 18,
                    bottom,
                },
                0x00322a25,
            );
        }
        y = bottom;
    }
}

fn log_status_color(status: u16) -> u32 {
    match status {
        200..=299 => 0x006ee7a8,
        300..=399 => 0x00dfaa72,
        400..=499 => 0x0024bffb,
        500..=599 => 0x006c70ff,
        _ => 0x008e949e,
    }
}

fn format_log_age(timestamp_ms: u64) -> String {
    let now_ms = SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map_or(timestamp_ms, |duration| duration.as_millis() as u64);
    format_log_age_at(timestamp_ms, now_ms)
}

fn format_log_age_at(timestamp_ms: u64, now_ms: u64) -> String {
    let seconds = now_ms.saturating_sub(timestamp_ms) / 1_000;
    match seconds {
        0..=4 => "방금".into(),
        5..=59 => format!("{seconds}초 전"),
        60..=3_599 => format!("{}분 전", seconds / 60),
        3_600..=86_399 => format!("{}시간 전", seconds / 3_600),
        _ => format!("{}일 전", seconds / 86_400),
    }
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

unsafe fn draw_account_pause_control(dc: HDC, rect: RECT, hot: bool, pressed: bool, busy: bool) {
    let color = if busy {
        0x006f7380
    } else if hot || pressed {
        0x00e9f4ef
    } else {
        0x009a9fa8
    };
    let cx = (rect.left + rect.right) / 2;
    // Account names use DrawText's vertically centered body-font box. Shift the
    // stroked silhouette by one pixel to share that optical text center/baseline.
    let cy = (rect.top + rect.bottom) / 2 + 1;
    // Pause: exclude this (currently active) account from the rotation pool.
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

unsafe fn draw_account_play_control(dc: HDC, rect: RECT, hot: bool, pressed: bool, busy: bool) {
    let color = if busy {
        0x006f7380
    } else if hot || pressed {
        0x00e9f4ef
    } else {
        0x008edbc0
    };
    let cx = (rect.left + rect.right) / 2;
    let cy = (rect.top + rect.bottom) / 2;
    // Standard right-pointing play triangle: "make this account active".
    for rect in play_triangle_columns(cx - 5, cy, 7, 5) {
        fill_solid(dc, rect, color);
    }
}

unsafe fn draw_reset_credit_control(
    dc: HDC,
    rect: RECT,
    available: u32,
    hot: bool,
    pressed: bool,
    busy: bool,
    font: HFONT,
) {
    let color = if busy {
        0x006f7380
    } else if hot || pressed {
        0x00e9f4ef
    } else {
        0x0024bffb
    };
    let left = rect.left + 2;
    let right = left + 15;
    let cy = (rect.top + rect.bottom) / 2;
    let top = cy - 6;
    let bottom = cy + 6;
    // Same Lucide ticket silhouette used by gui/src/icons.tsx::IconTicket:
    // rounded ticket body, opposing admission notches, and a dashed divider.
    let outline = [
        (left + 2, top),
        (right - 2, top),
        (right, top + 2),
        (right, cy - 3),
        (right - 2, cy - 2),
        (right - 3, cy),
        (right - 2, cy + 2),
        (right, cy + 3),
        (right, bottom - 2),
        (right - 2, bottom),
        (left + 2, bottom),
        (left, bottom - 2),
        (left, cy + 3),
        (left + 2, cy + 2),
        (left + 3, cy),
        (left + 2, cy - 2),
        (left, cy - 3),
        (left, top + 2),
        (left + 2, top),
    ];
    let pen = CreatePen(PS_SOLID, 1, COLORREF(color));
    let old_pen = SelectObject(dc, pen);
    let _ = MoveToEx(dc, outline[0].0, outline[0].1, None);
    for &(x, y) in &outline[1..] {
        let _ = LineTo(dc, x, y);
    }
    let divider_x = left + 8;
    for (from, to) in [
        (top + 1, top + 4),
        (cy - 1, cy + 2),
        (bottom - 4, bottom - 1),
    ] {
        let _ = MoveToEx(dc, divider_x, from, None);
        let _ = LineTo(dc, divider_x, to);
    }
    let _ = SelectObject(dc, old_pen);
    let _ = DeleteObject(pen);

    let old_font = SelectObject(dc, font);
    set_text_color(dc, color);
    draw_text(
        dc,
        &available.to_string(),
        RECT {
            left: right + 2,
            top: rect.top,
            right: rect.right - 1,
            bottom: rect.bottom,
        },
        DT_CENTER | DT_SINGLELINE | DT_VCENTER | DT_END_ELLIPSIS,
    );
    let _ = SelectObject(dc, old_font);
}

/// Column rects forming the standard RIGHT-pointing play triangle: the flat edge on
/// the left, narrowing to a 1px apex on the right (heights plateau at `max_half`).
fn play_triangle_columns(origin_x: i32, cy: i32, steps: i32, max_half: i32) -> Vec<RECT> {
    (0..steps)
        .map(|step| {
            let half = (steps - 1 - step).min(max_half);
            RECT {
                left: origin_x + step,
                top: cy - half,
                right: origin_x + step + 2,
                bottom: cy + half + 1,
            }
        })
        .collect()
}

unsafe fn draw_native_button(dc: HDC, rect: RECT, label: &str, disabled: bool) {
    fill_solid(dc, rect, if disabled { 0x00342f2c } else { 0x00483f39 });
    set_text_color(dc, if disabled { 0x007d817f } else { 0x00e9f4ef });
    draw_text(
        dc,
        label,
        rect,
        DT_CENTER | DT_SINGLELINE | DT_VCENTER | DT_END_ELLIPSIS,
    );
}

unsafe fn draw_provider_modal(
    dc: HDC,
    width: i32,
    height: i32,
    app: &mut App,
    body_font: HFONT,
    small_font: HFONT,
) {
    fill_solid(
        dc,
        RECT {
            left: 0,
            top: 0,
            right: width,
            bottom: height,
        },
        0x00211d1a,
    );
    let _ = SelectObject(dc, body_font);
    set_text_color(dc, 0x00f0ece8);
    let modal_title = match app.provider_modal.as_ref() {
        Some(ProviderModal::ResetCredits { .. }) => "초기화권",
        Some(ProviderModal::Connection { .. }) => "연결 설정",
        _ => "프로바이더 추가",
    };
    draw_text(
        dc,
        modal_title,
        RECT {
            left: 24,
            top: 14,
            right: width - 140,
            bottom: 50,
        },
        DT_LEFT | DT_SINGLELINE | DT_VCENTER,
    );
    let cancel = RECT {
        left: width - 112,
        top: 14,
        right: width - 24,
        bottom: 46,
    };
    draw_native_button(dc, cancel, "닫기", false);
    app.modal_hits.push((cancel, ModalHit::Cancel));
    let configs = app.state.configs.clone();
    match app.provider_modal.as_ref() {
        Some(ProviderModal::Picker {
            presets,
            loading,
            error,
            waiting_provider,
            waiting_codex,
            auth_details,
            url_copied_at,
            scroll,
            selected_tab,
            ..
        }) => {
            let _ = SelectObject(dc, small_font);
            for (index, (tab, label)) in [
                (ProviderCatalogTab::Accounts, "계정"),
                (ProviderCatalogTab::Free, "무료"),
                (ProviderCatalogTab::Paid, "유료"),
            ]
            .into_iter()
            .enumerate()
            {
                let tab_width = ((width - 48) / 3).max(72);
                let left = 24 + index as i32 * tab_width;
                let rect = RECT {
                    left,
                    top: 58,
                    right: if index == 2 {
                        width - 24
                    } else {
                        left + tab_width
                    },
                    bottom: 94,
                };
                if *selected_tab == tab {
                    fill_solid(dc, rect, 0x00342e2a);
                    fill_solid(
                        dc,
                        RECT {
                            top: rect.bottom - 3,
                            ..rect
                        },
                        0x009dcb4e,
                    );
                    set_text_color(dc, 0x00f0ece8);
                } else {
                    set_text_color(dc, 0x009da3ad);
                }
                draw_text(dc, label, rect, DT_CENTER | DT_SINGLELINE | DT_VCENTER);
                if waiting_provider.is_none() {
                    app.modal_hits.push((rect, ModalHit::Tab(tab)));
                }
            }
            if *loading {
                set_text_color(dc, 0x009da3ad);
                draw_text(
                    dc,
                    "Loading provider presets...",
                    RECT {
                        left: 40,
                        top: 108,
                        right: width - 40,
                        bottom: 150,
                    },
                    DT_LEFT | DT_SINGLELINE | DT_VCENTER,
                );
            } else if let Some(provider) = waiting_provider {
                set_text_color(dc, 0x008edbc0);
                let waiting_label = if *waiting_codex {
                    "OpenAI account"
                } else {
                    provider.as_str()
                };
                draw_text(
                    dc,
                    &format!("Waiting for {waiting_label} authorization..."),
                    RECT {
                        left: 40,
                        top: 108,
                        right: width - 40,
                        bottom: 138,
                    },
                    DT_LEFT | DT_SINGLELINE | DT_VCENTER | DT_END_ELLIPSIS,
                );
                let _ = SelectObject(dc, small_font);
                set_text_color(dc, 0x00d4d0cc);
                if let Some(details) = auth_details {
                    for (index, line) in auth_detail_lines(details).iter().take(5).enumerate() {
                        let top = 144 + index as i32 * 44;
                        let is_url = details
                            .url
                            .as_deref()
                            .map(str::trim)
                            .filter(|url| !url.is_empty())
                            .is_some_and(|url| *line == format!("URL: {url}"));
                        draw_text(
                            dc,
                            line,
                            RECT {
                                left: 40,
                                top,
                                right: width - if is_url { 84 } else { 40 },
                                bottom: top + 42,
                            },
                            DT_LEFT | DT_WORDBREAK,
                        );
                        if is_url {
                            let rect = RECT {
                                left: width - 80,
                                top,
                                right: width - 36,
                                bottom: top + 44,
                            };
                            let copied = url_copied_at
                                .is_some_and(|at| at.elapsed() < Duration::from_secs(2));
                            draw_copy_icon(dc, rect, copied);
                            app.modal_hits.push((rect, ModalHit::CopyAuthUrl));
                        }
                    }
                } else {
                    draw_text(
                        dc,
                        "Starting authorization...",
                        RECT {
                            left: 40,
                            top: 144,
                            right: width - 40,
                            bottom: 176,
                        },
                        DT_LEFT | DT_SINGLELINE | DT_VCENTER,
                    );
                }
            } else {
                let _ = IntersectClipRect(dc, 28, 104, width - 28, height - 58);
                let mut y = 108 - *scroll;
                let mut visible_count = 0;
                for (index, preset) in presets.iter().enumerate() {
                    if provider_catalog_tab(preset) != *selected_tab {
                        continue;
                    }
                    visible_count += 1;
                    let row = RECT {
                        left: 34,
                        top: y,
                        right: width - 34,
                        bottom: y + 48,
                    };
                    if row.bottom > 104 && row.top < height - 58 {
                        fill_solid(dc, row, 0x00342e2a);
                        set_text_color(dc, 0x00e9e4df);
                        draw_text(
                            dc,
                            &preset.label,
                            RECT {
                                left: row.left + 12,
                                top: y + 3,
                                right: row.right - 130,
                                bottom: y + 25,
                            },
                            DT_LEFT | DT_SINGLELINE | DT_VCENTER | DT_END_ELLIPSIS,
                        );
                        set_text_color(dc, 0x009da3ad);
                        let detail = preset.note.as_deref().unwrap_or(
                            match provider_preset_action(preset) {
                                ProviderPresetAction::CodexAccount => "ChatGPT account",
                                ProviderPresetAction::OAuth(_) => "OAuth",
                                ProviderPresetAction::ApiKey => "API key",
                                ProviderPresetAction::Unsupported => "Unsupported",
                            },
                        );
                        draw_text(
                            dc,
                            detail,
                            RECT {
                                left: row.left + 12,
                                top: y + 24,
                                right: row.right - 12,
                                bottom: y + 45,
                            },
                            DT_LEFT | DT_SINGLELINE | DT_VCENTER | DT_END_ELLIPSIS,
                        );
                        if configured_preset(preset, &configs) {
                            set_text_color(dc, 0x006ee7a8);
                            draw_text(
                                dc,
                                "Add key",
                                RECT {
                                    left: row.right - 118,
                                    top: y,
                                    right: row.right - 12,
                                    bottom: y + 48,
                                },
                                DT_RIGHT | DT_SINGLELINE | DT_VCENTER,
                            );
                        }
                        app.modal_hits.push((row, ModalHit::Preset(index)));
                    }
                    y += 54;
                }
                let _ = SelectClipRgn(dc, None);
                if visible_count == 0 {
                    set_text_color(dc, 0x009da3ad);
                    draw_text(
                        dc,
                        "이 분류에 표시할 프로바이더가 없습니다.",
                        RECT {
                            left: 40,
                            top: 120,
                            right: width - 40,
                            bottom: 160,
                        },
                        DT_CENTER | DT_SINGLELINE | DT_VCENTER,
                    );
                }
            }
            if let Some(error) = error {
                set_text_color(dc, 0x0024bffb);
                draw_text(
                    dc,
                    error,
                    RECT {
                        left: 40,
                        top: height - 56,
                        right: width - 40,
                        bottom: height - 24,
                    },
                    DT_LEFT | DT_SINGLELINE | DT_VCENTER | DT_END_ELLIPSIS,
                );
            }
        }
        Some(ProviderModal::ApiKey {
            preset,
            submitting,
            error,
            add_key,
        }) => {
            set_text_color(dc, 0x00e9e4df);
            draw_text(
                dc,
                &format!("{} API key", preset.label),
                RECT {
                    left: 60,
                    top: 150,
                    right: width - 60,
                    bottom: 190,
                },
                DT_LEFT | DT_SINGLELINE | DT_VCENTER | DT_END_ELLIPSIS,
            );
            let _ = SelectObject(dc, small_font);
            set_text_color(dc, 0x009da3ad);
            draw_text(
                dc,
                if *add_key {
                    "기존 프로바이더에 키가 추가되며 새 키가 활성 계정이 됩니다."
                } else if supports_account_id_base_url(preset) {
                    "Cloudflare Account ID와 API key를 입력하세요. Workers AI 무료 tier를 사용합니다."
                } else if preset.auth.eq_ignore_ascii_case("local") {
                    "로컬 endpoint입니다. API key 없이 현재 PC의 provider를 추가합니다."
                } else if preset.key_optional {
                    "키를 입력하면 계정별 슬롯으로 저장됩니다. 비워두면 provider의 keyless 방식으로 추가합니다."
                } else {
                    "키는 OCX로 직접 전송되며 사용 후 입력란에서 지워집니다."
                },
                RECT {
                    left: 60,
                    top: 188,
                    right: width - 60,
                    bottom: 230,
                },
                DT_LEFT | DT_WORDBREAK,
            );
            let needs_account_id = !*add_key && supports_account_id_base_url(preset);
            if needs_account_id {
                set_text_color(dc, 0x009da3ad);
                draw_text(
                    dc,
                    "Cloudflare Account ID",
                    RECT {
                        left: 60,
                        top: 232,
                        right: width - 60,
                        bottom: 252,
                    },
                    DT_LEFT | DT_SINGLELINE | DT_VCENTER,
                );
                draw_text(
                    dc,
                    "API key",
                    RECT {
                        left: 60,
                        top: 296,
                        right: width - 60,
                        bottom: 316,
                    },
                    DT_LEFT | DT_SINGLELINE | DT_VCENTER,
                );
            }
            let add_top = if needs_account_id { 370 } else { 286 };
            let add = RECT {
                left: width - 154,
                top: add_top,
                right: width - 60,
                bottom: add_top + 34,
            };
            draw_native_button(
                dc,
                add,
                if *submitting { "Adding..." } else { "Add" },
                *submitting,
            );
            if !*submitting {
                app.modal_hits.push((add, ModalHit::AddKey));
            }
            if let Some(error) = error {
                set_text_color(dc, 0x0024bffb);
                draw_text(
                    dc,
                    error,
                    RECT {
                        left: 60,
                        top: add_top + 46,
                        right: width - 60,
                        bottom: add_top + 94,
                    },
                    DT_LEFT | DT_WORDBREAK,
                );
            }
        }
        Some(ProviderModal::KiroAccountChoice) => {
            let _ = SelectObject(dc, small_font);
            set_text_color(dc, 0x00e9e4df);
            draw_text(
                dc,
                "Kiro 계정 유형을 선택하세요.",
                RECT {
                    left: 60,
                    top: 142,
                    right: width - 60,
                    bottom: 184,
                },
                DT_LEFT | DT_SINGLELINE | DT_VCENTER,
            );
            set_text_color(dc, 0x009da3ad);
            // Personal Kiro login drives the Kiro CLI on the OCX host, so it only
            // works when OCX runs on this PC. Organization login is device-code
            // based and works remotely.
            let remote = app.state.remote;
            draw_text(
                dc,
                if remote {
                    "원격 서버에서는 개인 계정 로그인을 사용할 수 없습니다(서버의 Kiro CLI가 필요). 조직 계정은 IAM Identity Center Start URL과 region으로 원격에서도 로그인할 수 있습니다."
                } else {
                    "개인 계정은 기존 Kiro 강제 계정 로그인을 시작합니다. 조직 계정은 IAM Identity Center Start URL과 region을 사용합니다."
                },
                RECT {
                    left: 60,
                    top: 184,
                    right: width - 60,
                    bottom: 254,
                },
                DT_LEFT | DT_WORDBREAK,
            );
            let personal = RECT {
                left: 60,
                top: 266,
                right: width - 60,
                bottom: 310,
            };
            let organization = RECT {
                left: 60,
                top: 324,
                right: width - 60,
                bottom: 368,
            };
            draw_native_button(dc, personal, "개인 계정", remote);
            draw_native_button(dc, organization, "조직 계정", false);
            if !remote {
                app.modal_hits.push((personal, ModalHit::KiroPersonal));
            }
            app.modal_hits
                .push((organization, ModalHit::KiroOrganization));
        }
        Some(ProviderModal::KiroOrganization { error }) => {
            let _ = SelectObject(dc, small_font);
            set_text_color(dc, 0x00e9e4df);
            draw_text(
                dc,
                "Kiro 조직 계정",
                RECT {
                    left: 60,
                    top: 132,
                    right: width - 60,
                    bottom: 174,
                },
                DT_LEFT | DT_SINGLELINE | DT_VCENTER,
            );
            set_text_color(dc, 0x009da3ad);
            draw_text(
                dc,
                "Start URL (https://example.awsapps.com/start)",
                RECT {
                    left: 60,
                    top: 194,
                    right: width - 60,
                    bottom: 218,
                },
                DT_LEFT | DT_SINGLELINE | DT_VCENTER,
            );
            draw_text(
                dc,
                "AWS region (예: us-east-1)",
                RECT {
                    left: 60,
                    top: 274,
                    right: width - 60,
                    bottom: 298,
                },
                DT_LEFT | DT_SINGLELINE | DT_VCENTER,
            );
            let submit = RECT {
                left: width - 174,
                top: 354,
                right: width - 60,
                bottom: 388,
            };
            draw_native_button(dc, submit, "로그인 시작", false);
            app.modal_hits
                .push((submit, ModalHit::KiroOrganizationSubmit));
            if let Some(error) = error {
                set_text_color(dc, 0x0024bffb);
                draw_text(
                    dc,
                    error,
                    RECT {
                        left: 60,
                        top: 402,
                        right: width - 60,
                        bottom: 454,
                    },
                    DT_LEFT | DT_WORDBREAK,
                );
            }
        }
        Some(ProviderModal::Connection {
            remote,
            submitting,
            error,
        }) => {
            let remote = *remote;
            let submitting = *submitting;
            let _ = SelectObject(dc, small_font);
            set_text_color(dc, 0x009da3ad);
            draw_text(
                dc,
                &format!("현재 연결 · {}", api::connection_base_url()),
                RECT {
                    left: 24,
                    top: 48,
                    right: width - 24,
                    bottom: 76,
                },
                DT_LEFT | DT_SINGLELINE | DT_VCENTER | DT_END_ELLIPSIS,
            );
            // Mode selector: two buttons, the selected one highlighted.
            let local_rect = RECT {
                left: 60,
                top: 92,
                right: width / 2 - 6,
                bottom: 130,
            };
            let remote_rect = RECT {
                left: width / 2 + 6,
                top: 92,
                right: width - 60,
                bottom: 130,
            };
            for (rect, label, selected, hit) in [
                (
                    local_rect,
                    "로컬 PC",
                    !remote,
                    ModalHit::ConnectionModeLocal,
                ),
                (
                    remote_rect,
                    "원격 서버",
                    remote,
                    ModalHit::ConnectionModeRemote,
                ),
            ] {
                fill_solid(dc, rect, if selected { 0x00483f39 } else { 0x00302b28 });
                if selected {
                    fill_solid(
                        dc,
                        RECT {
                            top: rect.bottom - 3,
                            ..rect
                        },
                        0x009dcb4e,
                    );
                }
                set_text_color(dc, if selected { 0x00f0ece8 } else { 0x009da3ad });
                draw_text(dc, label, rect, DT_CENTER | DT_SINGLELINE | DT_VCENTER);
                if !submitting {
                    app.modal_hits.push((rect, hit));
                }
            }
            if remote {
                set_text_color(dc, 0x009da3ad);
                draw_text(
                    dc,
                    "중앙 OCX 주소와 관리 토큰을 입력하세요. 토큰은 Windows 자격 증명 관리자에 저장되고 화면에는 다시 표시되지 않습니다.",
                    RECT { left: 60, top: 142, right: width - 60, bottom: 200 },
                    DT_LEFT | DT_WORDBREAK,
                );
                draw_text(
                    dc,
                    "서버 주소 (예: http://100.120.114.62:10100)",
                    RECT {
                        left: 60,
                        top: 210,
                        right: width - 60,
                        bottom: 234,
                    },
                    DT_LEFT | DT_SINGLELINE | DT_VCENTER,
                );
                draw_text(
                    dc,
                    "관리 토큰",
                    RECT {
                        left: 60,
                        top: 290,
                        right: width - 60,
                        bottom: 314,
                    },
                    DT_LEFT | DT_SINGLELINE | DT_VCENTER,
                );
                set_text_color(dc, 0x008e949e);
                draw_text(
                    dc,
                    "원격 모드에서는 시작·중지·재시작을 사용할 수 없고, 메모리는 서버에서 가져옵니다.",
                    RECT { left: 60, top: 356, right: width - 60, bottom: 404 },
                    DT_LEFT | DT_WORDBREAK,
                );
            } else {
                set_text_color(dc, 0x009da3ad);
                draw_text(
                    dc,
                    "이 PC의 OCX(127.0.0.1:10100)에 연결합니다. 저장된 원격 토큰은 삭제되고 기존 로컬 동작이 그대로 유지됩니다.",
                    RECT { left: 60, top: 142, right: width - 60, bottom: 210 },
                    DT_LEFT | DT_WORDBREAK,
                );
            }
            let save = RECT {
                left: width - 174,
                top: 412,
                right: width - 60,
                bottom: 448,
            };
            draw_native_button(
                dc,
                save,
                if submitting {
                    "확인 중…"
                } else {
                    "저장"
                },
                submitting,
            );
            if !submitting {
                app.modal_hits.push((save, ModalHit::ConnectionSave));
            }
            if let Some(error) = error {
                set_text_color(dc, 0x0024bffb);
                draw_text(
                    dc,
                    error,
                    RECT {
                        left: 60,
                        top: 456,
                        right: width - 60,
                        bottom: 524,
                    },
                    DT_LEFT | DT_WORDBREAK,
                );
            }
        }
        Some(ProviderModal::ResetCredits {
            control,
            credits,
            loading,
            confirming,
            submitting,
            error,
        }) => {
            let _ = SelectObject(dc, small_font);
            set_text_color(dc, 0x009da3ad);
            draw_text(
                dc,
                &control.identity,
                RECT {
                    left: 24,
                    top: 48,
                    right: width - 24,
                    bottom: 76,
                },
                DT_LEFT | DT_SINGLELINE | DT_VCENTER | DT_END_ELLIPSIS,
            );
            if *confirming {
                set_text_color(dc, 0x0024bffb);
                draw_text(
                    dc,
                    "!",
                    RECT {
                        left: width / 2 - 20,
                        top: 116,
                        right: width / 2 + 20,
                        bottom: 158,
                    },
                    DT_CENTER | DT_SINGLELINE | DT_VCENTER,
                );
                let _ = SelectObject(dc, body_font);
                set_text_color(dc, 0x00f0ece8);
                draw_text(
                    dc,
                    "초기화권 1개를 사용할까요?",
                    RECT {
                        left: 40,
                        top: 164,
                        right: width - 40,
                        bottom: 202,
                    },
                    DT_CENTER | DT_SINGLELINE | DT_VCENTER,
                );
                let _ = SelectObject(dc, small_font);
                set_text_color(dc, 0x009da3ad);
                let next_credit = credits.first().map(|credit| {
                    format!(
                        "다음 사용권 · 만료 {}",
                        format_credit_timestamp(&credit.expires_at)
                    )
                });
                draw_text(
                    dc,
                    next_credit
                        .as_deref()
                        .unwrap_or("다음 사용권 정보를 불러오지 못했습니다"),
                    RECT {
                        left: 40,
                        top: 210,
                        right: width - 40,
                        bottom: 242,
                    },
                    DT_CENTER | DT_SINGLELINE | DT_VCENTER | DT_END_ELLIPSIS,
                );
                draw_text(
                    dc,
                    "현재 시간/주간 사용량 제한이 즉시 초기화되며 되돌릴 수 없습니다.",
                    RECT {
                        left: 48,
                        top: 250,
                        right: width - 48,
                        bottom: 292,
                    },
                    DT_CENTER | DT_WORDBREAK,
                );
                let cancel_rect = RECT {
                    left: width / 2 - 144,
                    top: 322,
                    right: width / 2 - 8,
                    bottom: 358,
                };
                let confirm_rect = RECT {
                    left: width / 2 + 8,
                    top: 322,
                    right: width / 2 + 144,
                    bottom: 358,
                };
                draw_native_button(dc, cancel_rect, "취소", *submitting);
                draw_native_button(
                    dc,
                    confirm_rect,
                    if *submitting {
                        "사용 중…"
                    } else {
                        "초기화권 사용"
                    },
                    *submitting,
                );
                if !*submitting {
                    app.modal_hits
                        .push((cancel_rect, ModalHit::ResetCreditConfirmCancel));
                    app.modal_hits
                        .push((confirm_rect, ModalHit::ResetCreditConfirm));
                }
            } else if *loading {
                set_text_color(dc, 0x009da3ad);
                draw_text(
                    dc,
                    "초기화권 정보를 불러오는 중…",
                    RECT {
                        left: 40,
                        top: 110,
                        right: width - 40,
                        bottom: 160,
                    },
                    DT_CENTER | DT_SINGLELINE | DT_VCENTER,
                );
            } else {
                set_text_color(dc, 0x00e9e4df);
                draw_text(
                    dc,
                    &format!("사용 가능한 초기화권 {}개", control.available),
                    RECT {
                        left: 32,
                        top: 82,
                        right: width - 32,
                        bottom: 112,
                    },
                    DT_LEFT | DT_SINGLELINE | DT_VCENTER,
                );
                if credits.is_empty() {
                    set_text_color(dc, 0x009da3ad);
                    draw_text(
                        dc,
                        "표시할 초기화권이 없습니다.",
                        RECT {
                            left: 40,
                            top: 132,
                            right: width - 40,
                            bottom: 180,
                        },
                        DT_CENTER | DT_SINGLELINE | DT_VCENTER,
                    );
                } else {
                    for (index, credit) in credits.iter().take(5).enumerate() {
                        let top = 118 + index as i32 * 62;
                        let row = RECT {
                            left: 30,
                            top,
                            right: width - 30,
                            bottom: top + 56,
                        };
                        fill_solid(dc, row, if index == 0 { 0x003a312b } else { 0x002d2825 });
                        draw_reset_credit_control(
                            dc,
                            RECT {
                                left: row.left + 10,
                                top: row.top + 13,
                                right: row.left + 42,
                                bottom: row.top + 43,
                            },
                            (index + 1) as u32,
                            index == 0,
                            false,
                            false,
                            small_font,
                        );
                        set_text_color(dc, if index == 0 { 0x0024bffb } else { 0x00e9e4df });
                        draw_text(
                            dc,
                            if index == 0 {
                                "다음 사용"
                            } else {
                                "대기"
                            },
                            RECT {
                                left: row.left + 52,
                                top: row.top + 3,
                                right: row.right - 12,
                                bottom: row.top + 26,
                            },
                            DT_LEFT | DT_SINGLELINE | DT_VCENTER,
                        );
                        set_text_color(dc, 0x009da3ad);
                        draw_text(
                            dc,
                            &format!(
                                "지급 {}  ·  만료 {}",
                                format_credit_timestamp(&credit.granted_at),
                                format_credit_timestamp(&credit.expires_at)
                            ),
                            RECT {
                                left: row.left + 52,
                                top: row.top + 27,
                                right: row.right - 12,
                                bottom: row.bottom - 3,
                            },
                            DT_LEFT | DT_SINGLELINE | DT_VCENTER | DT_END_ELLIPSIS,
                        );
                        if index == 0 && !*submitting {
                            app.modal_hits.push((row, ModalHit::ResetCreditUse));
                        }
                    }
                }
                let use_rect = RECT {
                    left: 48,
                    top: 446,
                    right: width - 48,
                    bottom: 484,
                };
                let disabled = *submitting || control.available == 0 || credits.is_empty();
                draw_native_button(dc, use_rect, "다음 초기화권 사용", disabled);
                if !disabled {
                    app.modal_hits.push((use_rect, ModalHit::ResetCreditUse));
                }
                set_text_color(dc, 0x008e949e);
                draw_text(
                    dc,
                    "초기화권은 만료 순서에 따라 다음 사용권부터 사용됩니다.",
                    RECT {
                        left: 36,
                        top: 490,
                        right: width - 36,
                        bottom: 520,
                    },
                    DT_CENTER | DT_SINGLELINE | DT_VCENTER | DT_END_ELLIPSIS,
                );
            }
            if let Some(error) = error {
                set_text_color(dc, 0x0024bffb);
                draw_text(
                    dc,
                    error,
                    RECT {
                        left: 36,
                        top: 520,
                        right: width - 36,
                        bottom: 548,
                    },
                    DT_CENTER | DT_SINGLELINE | DT_VCENTER | DT_END_ELLIPSIS,
                );
            }
        }
        None => {}
    }
}

unsafe fn draw_copy_icon(dc: HDC, rect: RECT, copied: bool) {
    let x = (rect.left + rect.right) / 2 - 8;
    let y = (rect.top + rect.bottom) / 2 - 8;
    let pen = CreatePen(
        PS_SOLID,
        1,
        COLORREF(if copied { 0x006ee7a8 } else { 0x00d4d0cc }),
    );
    let old_pen = SelectObject(dc, pen);
    let paths: &[&[(i32, i32)]] = if copied {
        &[&[(1, 8), (6, 13), (16, 3)]]
    } else {
        &[
            &[(3, 11), (0, 11), (0, 0), (11, 0), (11, 3)],
            &[(5, 5), (16, 5), (16, 16), (5, 16), (5, 5)],
        ]
    };
    for path in paths {
        let _ = MoveToEx(dc, x + path[0].0, y + path[0].1, None);
        for &(dx, dy) in &path[1..] {
            let _ = LineTo(dc, x + dx, y + dy);
        }
    }
    let _ = SelectObject(dc, old_pen);
    let _ = DeleteObject(pen);
    set_text_color(dc, 0x00d4d0cc);
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

fn gdi_text_units(text: &str) -> Option<Vec<u16>> {
    (!text.is_empty()).then(|| text.encode_utf16().collect())
}

unsafe fn draw_text(dc: HDC, text: &str, mut rect: RECT, format: DRAW_TEXT_FORMAT) {
    let Some(mut wide) = gdi_text_units(text) else {
        return;
    };
    let _ = DrawTextW(dc, &mut wide, &mut rect, format);
}

unsafe fn measure_text_width(dc: HDC, text: &str) -> i32 {
    let Some(mut wide) = gdi_text_units(text) else {
        return 0;
    };
    let mut rect = RECT::default();
    let _ = DrawTextW(
        dc,
        &mut wide,
        &mut rect,
        DT_CALCRECT | DT_SINGLELINE | DT_NOPREFIX,
    );
    rect.right - rect.left
}

/// Draw every quota window as a column in one compact horizontal row.
///
/// The list is produced from the management API payload, including any
/// provider-specific `customWindows`, so this layout intentionally has no
/// knowledge of plans or provider names. New windows automatically become
/// additional columns (with an adaptive width and gap).
unsafe fn draw_quota_columns(
    dc: HDC,
    columns: &[QuotaBarColumn],
    left: i32,
    right: i32,
    top: i32,
    font: HFONT,
    threshold: u32,
) {
    if columns.is_empty() || right <= left {
        return;
    }

    let count = columns.len() as i32;
    let gap = if count > 4 { 6 } else { 8 };
    let available = right - left;
    let usable = (available - gap * (count - 1)).max(count);
    let column_width = (usable / count).max(1);
    let _ = SelectObject(dc, font);

    for (index, column) in columns.iter().enumerate() {
        let x0 = left + index as i32 * (column_width + gap);
        if x0 >= right {
            break;
        }
        let x1 = if index + 1 == columns.len() {
            right
        } else {
            (x0 + column_width).min(right)
        };
        if x1 <= x0 {
            continue;
        }

        let percent = column.percent.unwrap_or(0.0);
        let warning = (threshold > 0 && percent >= threshold as f64) || percent >= 99.5;
        let head = match format_reset(column.reset_at) {
            Some(reset) => format!("{} · {}", column.label, reset),
            None => column.label.clone(),
        };
        let value_width = (x1 - x0).min(48).max(18);
        let label_right = (x1 - value_width).max(x0 + 1);

        set_text_color(dc, if warning { 0x0024bffb } else { 0x00a6a6a6 });
        draw_text(
            dc,
            &head,
            RECT {
                left: x0,
                top,
                right: label_right,
                bottom: top + 14,
            },
            DT_LEFT | DT_SINGLELINE | DT_VCENTER | DT_END_ELLIPSIS,
        );

        if let Some(value) = &column.value_label {
            // Text-only windows (for example an estimated cost) still occupy
            // a column, but do not draw a misleading percentage bar.
            set_text_color(dc, 0x00ececec);
            draw_text(
                dc,
                value,
                RECT {
                    left: label_right,
                    top,
                    right: x1,
                    bottom: top + 14,
                },
                DT_RIGHT | DT_SINGLELINE | DT_VCENTER | DT_END_ELLIPSIS,
            );
            continue;
        }

        set_text_color(dc, if warning { 0x0024bffb } else { 0x00ececec });
        draw_text(
            dc,
            &format_percent(percent),
            RECT {
                left: label_right,
                top,
                right: x1,
                bottom: top + 14,
            },
            DT_RIGHT | DT_SINGLELINE | DT_VCENTER | DT_END_ELLIPSIS,
        );
        fill_solid(
            dc,
            RECT {
                left: x0,
                top: top + 16,
                right: x1,
                bottom: top + 21,
            },
            0x00303030,
        );
        draw_quota_fill(dc, x0, x1, top + 16, percent, warning);
    }
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

fn diagnostic_log_path() -> Option<PathBuf> {
    std::env::var_os("LOCALAPPDATA")
        .map(|root| PathBuf::from(root).join("OCX Notch").join("ocx-notch.log"))
}

fn append_diagnostic_log(kind: &str, detail: &str) {
    let Some(path) = diagnostic_log_path() else {
        return;
    };
    let Some(parent) = path.parent() else {
        return;
    };
    if fs::create_dir_all(parent).is_err() {
        return;
    }
    if fs::metadata(&path)
        .ok()
        .is_some_and(|metadata| metadata.len() >= DIAGNOSTIC_LOG_MAX_BYTES)
    {
        let _ = fs::write(&path, []);
    }
    let Ok(mut file) = OpenOptions::new().create(true).append(true).open(path) else {
        return;
    };
    let timestamp = SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .unwrap_or_default()
        .as_secs();
    let detail = detail.replace(['\r', '\n'], " ");
    let _ = writeln!(file, "{timestamp} {kind}: {detail}");
}

fn install_panic_logger() {
    let previous = panic::take_hook();
    panic::set_hook(Box::new(move |info| {
        append_diagnostic_log("panic", &info.to_string());
        previous(info);
    }));
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
    let (x, y, width, _) =
        clamp_window_to_work_area(placement.x, placement.y, saved_width, height, info.rcWork);
    let _ = SetWindowPos(hwnd, HWND_TOPMOST, x, y, width, height, SWP_NOACTIVATE);
    width
}

fn clamp_window_to_work_area(
    x: i32,
    y: i32,
    width: i32,
    height: i32,
    work: RECT,
) -> (i32, i32, i32, i32) {
    let work_width = (work.right - work.left).max(1);
    let work_height = (work.bottom - work.top).max(1);
    let width = width.clamp(1, work_width);
    let height = height.clamp(1, work_height);
    let x = x.clamp(work.left, work.right - width);
    let y = y.clamp(work.top, work.bottom - height);
    (x, y, width, height)
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

    fn model_row(provider: &str, id: &str, disabled: bool, native: bool) -> ModelRow {
        ModelRow {
            provider: provider.into(),
            id: id.into(),
            namespaced: if native {
                id.into()
            } else {
                format!("{provider}/{id}")
            },
            disabled,
            native,
            display_name: None,
        }
    }

    fn loaded_model_state() -> ModelsState {
        let mut state = ModelsState::default();
        state.apply_rows(vec![
            model_row("kiro", "auto", false, false),
            model_row("kiro", "claude", false, false),
            model_row("openai", "gpt-native", true, true),
        ]);
        state.apply_selected(SelectedModelsResponse {
            selected: [("kiro".into(), vec!["auto".into(), "claude".into()])].into(),
        });
        state
    }

    #[test]
    fn all_content_tabs_are_clickable_at_the_minimum_window_width() {
        for tab in [
            ContentTab::Providers,
            ContentTab::Logs,
            ContentTab::Models,
            ContentTab::Subagents,
        ] {
            let rect = content_tab_rect(tab);
            assert!(rect.right < MIN_WIDTH - 14);
            assert_eq!(
                content_tab_at(
                    MIN_WIDTH,
                    (rect.left + rect.right) / 2,
                    (rect.top + rect.bottom) / 2
                ),
                Some(tab)
            );
        }
    }

    #[test]
    fn model_providers_start_collapsed_and_only_expanded_rows_add_height() {
        let state = loaded_model_state();
        let mut expanded = HashSet::new();

        assert_eq!(models_content_height(&state, &expanded), 44 + 2 * 34);
        expanded.insert("kiro".to_string());
        assert_eq!(
            models_content_height(&state, &expanded),
            44 + 2 * 34 + 2 * 38
        );
        assert!(!expanded.contains("openai"));
    }

    #[test]
    fn provider_aggregate_reports_partial_and_partial_enables_next() {
        let mut state = loaded_model_state();
        state.selected.insert("kiro".into(), vec!["auto".into()]);

        let aggregate = provider_visibility(&state, "kiro");
        assert_eq!(aggregate, ProviderVisibility::Mixed);
        assert!(aggregate != ProviderVisibility::AllOn);

        state.selected.insert("kiro".into(), Vec::new());
        assert_eq!(
            provider_visibility(&state, "kiro"),
            ProviderVisibility::AllOn
        );
    }

    #[test]
    fn provider_visibility_request_contains_every_native_aware_target() {
        let rows = vec![
            model_row("openai", "gpt-routed", false, false),
            model_row("openai", "gpt-native", true, true),
        ];

        assert_eq!(
            serde_json::to_value(provider_visibility_request("openai", &rows, true)).unwrap(),
            serde_json::json!({
                "scope": "models",
                "provider": "openai",
                "targets": [
                    {"id": "gpt-routed"},
                    {"id": "gpt-native", "native": true}
                ],
                "enabled": true
            })
        );
    }

    #[test]
    fn a_connection_change_is_refused_while_any_login_or_mutation_is_outstanding() {
        assert!(!connection_change_blocked(0, false));
        assert!(connection_change_blocked(1, false));
        assert!(connection_change_blocked(0, true));
    }

    #[test]
    fn cli_accepts_only_bootstrap_modes_and_never_a_token_argument() {
        assert_eq!(parse_cli(Vec::<String>::new()).unwrap(), Cli::Window);
        assert_eq!(parse_cli(vec!["--local".into()]).unwrap(), Cli::Local);
        assert_eq!(
            parse_cli(vec!["--connect".into(), "http://10.0.0.5:10100".into()]).unwrap(),
            Cli::Connect("http://10.0.0.5:10100".into())
        );
        // A token passed on the command line is refused rather than accepted:
        // argv is readable by every process on the machine.
        assert!(parse_cli(vec![
            "--connect".into(),
            "http://10.0.0.5:10100".into(),
            "ocx_admin_secret".into()
        ])
        .is_err());
        assert!(parse_cli(vec!["--connect".into()]).is_err());
        assert!(parse_cli(vec!["--token".into()]).is_err());
    }

    #[test]
    fn only_plain_web_authorization_urls_reach_the_shell() {
        assert!(openable_authorization_url(
            "https://auth.example.com/oauth/authorize?state=abc&code_challenge=xyz"
        ));
        for rejected in [
            "file:///C:/Windows/System32/cmd.exe",
            "javascript:alert(1)",
            "https://example.com/a b",
            "https://example.com/\"quoted\"",
            "https://example.com/\nnewline",
            "https://",
        ] {
            assert!(!openable_authorization_url(rejected), "accepted {rejected}");
        }
    }

    #[test]
    fn remote_mode_shows_server_memory_and_ignores_local_process_samples() {
        let mut state = ViewState {
            remote: true,
            ..Default::default()
        };
        apply_local_process_memory(
            &mut state,
            4242,
            999,
            888,
            Some(SystemMemory {
                physical_total: 32 * GIB,
                physical_available: 8 * GIB,
                commit_total: 16 * GIB,
                commit_limit: 48 * GIB,
            }),
        );
        assert_eq!(
            (state.pid, state.working_set, state.private_commit),
            (0, 0, 0)
        );
        assert!(state.system_memory.is_none());

        apply_memory_details(
            &mut state,
            MemoryDetails {
                heap_used: Some(11),
                rss: Some(700),
                heap_total: Some(300),
                observed_bytes: Some(500),
            },
        );
        assert_eq!(state.working_set, 700);
        assert_eq!(state.private_commit, 500);
        assert!(state.system_memory.is_none());
    }

    #[test]
    fn local_mode_keeps_process_samples_and_local_capacity() {
        let mut state = ViewState::default();
        let memory = SystemMemory {
            physical_total: 32 * GIB,
            physical_available: 8 * GIB,
            commit_total: 16 * GIB,
            commit_limit: 48 * GIB,
        };
        apply_local_process_memory(&mut state, 4242, 999, 888, Some(memory));
        apply_memory_details(
            &mut state,
            MemoryDetails {
                heap_used: Some(11),
                rss: Some(700),
                heap_total: Some(300),
                observed_bytes: Some(500),
            },
        );
        assert_eq!(
            (state.pid, state.working_set, state.private_commit),
            (4242, 999, 888)
        );
        assert!(state.system_memory.is_some());
        assert_eq!(
            state.details.and_then(|details| details.heap_used),
            Some(11)
        );
    }

    #[test]
    fn oversized_refresh_age_cannot_underflow_the_monotonic_clock() {
        let now = Instant::now();
        assert_eq!(refresh_seed(now, Duration::MAX), now);
    }

    #[test]
    fn background_logs_stay_warm_and_failed_provider_fetches_retry_quickly() {
        assert_eq!(logs_refresh_interval(false), Duration::from_secs(30));
        assert_eq!(logs_refresh_interval(true), Duration::from_secs(2));
        assert_eq!(account_quota_refresh_interval(), Duration::from_secs(2));
        assert_eq!(provider_refresh_interval(false), Duration::from_secs(5));
        assert_eq!(provider_refresh_interval(true), Duration::from_secs(300));
    }

    #[test]
    fn reauth_excludes_main_but_allows_pool_and_generic_accounts() {
        let main = AccountView {
            id: "__main__".into(),
            needs_reauth: true,
            is_main: true,
            ..Default::default()
        };
        let pool = AccountView {
            id: "pool-2".into(),
            needs_reauth: true,
            ..Default::default()
        };
        assert!(!reauth_eligible("openai", &main));
        assert!(reauth_eligible("openai", &pool));
        assert!(reauth_eligible("kiro", &main));
    }

    #[test]
    fn reauth_text_shares_the_account_name_row_without_extra_height() {
        let top = 120;
        let rect = reauth_action_rect(DEFAULT_WIDTH, top);
        assert_eq!(rect.top, top);
        assert_eq!(rect.bottom, top + 30);
        assert_eq!(
            account_height(&AccountView::default()),
            account_height(&AccountView {
                needs_reauth: true,
                ..Default::default()
            })
        );
    }

    #[test]
    fn reauth_and_waiting_states_share_the_attention_color() {
        assert_eq!(reauth_text_color(false), 0x0024bffb);
        assert_eq!(reauth_text_color(true), 0x0024bffb);
    }

    #[test]
    fn reset_credit_action_uses_the_existing_account_row_only_when_available() {
        let without_credit = AccountView::default();
        let with_credit = AccountView {
            quota: Some(Quota {
                reset_credits: Some(1),
                ..Default::default()
            }),
            ..Default::default()
        };
        let zero_credit = AccountView {
            quota: Some(Quota {
                reset_credits: Some(0),
                ..Default::default()
            }),
            ..Default::default()
        };

        assert_eq!(reset_credit_count(&without_credit), None);
        assert_eq!(reset_credit_count(&zero_credit), None);
        assert_eq!(reset_credit_count(&with_credit), Some(1));
        assert_eq!(
            account_height(&with_credit),
            account_height(&without_credit)
        );
    }

    #[test]
    fn empty_text_never_reaches_win32_gdi() {
        assert_eq!(gdi_text_units(""), None);
        assert_eq!(
            gdi_text_units("재인증"),
            Some("재인증".encode_utf16().collect())
        );
    }

    #[test]
    fn provider_catalog_matches_account_free_paid_tabs() {
        let oauth = ProviderPreset {
            auth: "oauth".into(),
            ..Default::default()
        };
        let kiro = ProviderPreset {
            id: "kiro".into(),
            auth: "oauth".into(),
            oauth_provider: Some("kiro".into()),
            ..Default::default()
        };
        let free = ProviderPreset {
            auth: "key".into(),
            free_tier: true,
            base_url: "https://example.test/v1".into(),
            ..Default::default()
        };
        let opencode_free = ProviderPreset {
            id: "opencode-free".into(),
            auth: "key".into(),
            key_optional: true,
            base_url: "https://opencode.ai/zen/v1".into(),
            ..Default::default()
        };
        let cloudflare_free = ProviderPreset {
            id: "cloudflare-workers-ai".into(),
            auth: "key".into(),
            free_tier: true,
            base_url: "https://api.cloudflare.com/client/v4/accounts/{account_id}/ai/v1".into(),
            ..Default::default()
        };
        let ollama_local = ProviderPreset {
            id: "ollama".into(),
            auth: "local".into(),
            base_url: "http://localhost:11434/v1".into(),
            ..Default::default()
        };
        let paid = ProviderPreset {
            auth: "key".into(),
            ..Default::default()
        };
        assert_eq!(provider_catalog_tab(&oauth), ProviderCatalogTab::Accounts);
        assert_eq!(
            provider_preset_action(&kiro),
            ProviderPresetAction::OAuth("kiro".into())
        );
        assert_eq!(provider_catalog_tab(&kiro), ProviderCatalogTab::Accounts);
        assert_eq!(provider_catalog_tab(&free), ProviderCatalogTab::Free);
        assert_eq!(
            provider_catalog_tab(&opencode_free),
            ProviderCatalogTab::Free
        );
        assert_eq!(
            provider_catalog_tab(&cloudflare_free),
            ProviderCatalogTab::Free
        );
        assert_eq!(
            provider_catalog_tab(&ollama_local),
            ProviderCatalogTab::Free
        );
        assert_eq!(provider_catalog_tab(&paid), ProviderCatalogTab::Paid);
    }

    #[test]
    fn configured_account_presets_remain_clickable_for_add_account() {
        let preset = ProviderPreset {
            id: "openai".into(),
            auth: "forward".into(),
            codex_account_mode: Some("pool".into()),
            ..Default::default()
        };
        let configs = vec![ProviderConfig {
            name: "openai".into(),
            ..Default::default()
        }];

        assert!(!configured_preset(&preset, &configs));
    }

    #[test]
    fn configured_key_presets_stay_clickable_and_add_to_the_pool() {
        let preset = ProviderPreset {
            id: "opencode-go".into(),
            label: "opencode go".into(),
            adapter: "openai-chat".into(),
            base_url: "https://opencode.ai/zen/go/v1".into(),
            auth: "key".into(),
            ..Default::default()
        };
        let configs = vec![ProviderConfig {
            name: "opencode-go".into(),
            ..Default::default()
        }];

        assert!(configured_preset(&preset, &configs));
        // A configured key preset must still open the key modal in add-key mode
        // (POST /api/providers/keys) so extra accounts can be added from Notch.
        assert!(api_key_preset_adds_key(&preset, &configs));
    }

    #[test]
    fn cancel_requested_before_codex_flow_id_is_retained_for_remote_cancel() {
        let cancel = AuthCancellation::default();
        cancel.request();

        assert!(cancel.publish_flow_id("flow-late".into()));
        assert_eq!(cancel.flow_id().as_deref(), Some("flow-late"));
    }

    #[test]
    fn reauth_cancel_keeps_mutation_slot_until_worker_finishes_remote_cancel() {
        let key = "openai:pool-a".to_string();
        let cancel = Arc::new(AuthCancellation::default());
        let mutations = HashMap::from([(key.clone(), cancel.clone())]);

        assert!(request_existing_reauth_cancel(&mutations, &key));
        assert!(mutations.contains_key(&key));
        assert!(cancel.is_requested());
    }

    #[test]
    fn codex_add_and_reauth_use_current_status_and_cancel_contracts() {
        assert_eq!(
            codex_login_status_path("flow/a", None, false),
            "/api/codex-auth/login-status?flowId=flow%2Fa"
        );
        assert_eq!(
            codex_login_status_path("flow/a", Some("pool b"), true),
            "/api/codex-auth/login-status?flowId=flow%2Fa&accountId=pool%20b&reauth=1"
        );
    }

    #[test]
    fn codex_reauth_cancels_a_stale_login_and_retries_once() {
        let mut starts = 0;
        let mut cancels = 0;
        let result = retry_codex_login_after_conflict(
            || {
                starts += 1;
                if starts == 1 {
                    Err("OCX returned HTTP 409: login already in progress".into())
                } else {
                    Ok("flow-ready")
                }
            },
            || {
                cancels += 1;
                Ok(())
            },
        );

        assert_eq!(result.as_deref(), Ok("flow-ready"));
        assert_eq!(starts, 2);
        assert_eq!(cancels, 1);
    }

    #[test]
    fn codex_reauth_surfaces_a_second_conflict_without_looping() {
        let mut starts = 0;
        let mut cancels = 0;
        let result = retry_codex_login_after_conflict::<()>(
            || {
                starts += 1;
                Err("OCX returned HTTP 409: login already in progress".into())
            },
            || {
                cancels += 1;
                Ok(())
            },
        );

        assert_eq!(
            result,
            Err("OCX returned HTTP 409: login already in progress".into())
        );
        assert_eq!(starts, 2);
        assert_eq!(cancels, 1);
    }

    #[test]
    fn device_authorization_details_remain_visible_in_the_modal() {
        let details = AuthFlowResponse {
            url: Some("https://github.com/login/device".into()),
            instructions: Some("Enter the code shown below".into()),
            device_code: Some("ABCD-EFGH".into()),
            ..Default::default()
        };

        assert_eq!(
            auth_detail_lines(&details),
            [
                "Enter the code shown below",
                "Code: ABCD-EFGH",
                "URL: https://github.com/login/device",
            ]
        );
    }

    #[test]
    fn closing_api_key_modal_requires_native_password_control_cleanup() {
        assert!(!api_key_edit_needs_cleanup(true, true));
        assert!(api_key_edit_needs_cleanup(false, true));
        assert!(!api_key_edit_needs_cleanup(false, false));
    }

    #[test]
    fn kiro_organization_request_canonicalizes_transient_input() {
        assert_eq!(
            kiro_organization_request(" HTTPS://D-Example.awsapps.com/start/ ", " us-east-1 "),
            Ok((
                "https://d-example.awsapps.com/start".into(),
                "us-east-1".into()
            ))
        );
    }

    #[test]
    fn kiro_organization_request_rejects_noncanonical_start_urls() {
        for start_url in [
            "http://d-example.awsapps.com/start",
            "https://awsapps.com/start",
            "https://.awsapps.com/start",
            "https://d-example.awsapps.com/other",
            "https://d-example.awsapps.com/start?organization=secret",
            "https://d.example.awsapps.com/start",
            "https://user@d-example.awsapps.com/start",
            "https://d-example.awsapps.com:443/start",
            "https://d-example.awsapps.com/start#fragment",
            "https://-example.awsapps.com/start",
            "https://example-.awsapps.com/start",
            "https://example.com/start",
        ] {
            assert!(
                kiro_organization_request(start_url, "us-east-1").is_err(),
                "accepted {start_url}"
            );
        }
        assert!(kiro_organization_request(
            &format!("https://{}.awsapps.com/start", "a".repeat(64)),
            "us-east-1"
        )
        .is_err());
        assert!(kiro_organization_request(
            &format!("https://d-example.awsapps.com/start{}", " ".repeat(2049)),
            "us-east-1"
        )
        .is_err());
        assert!(
            kiro_organization_request("https://d-example.awsapps.com/start\n", "us-east-1")
                .is_err()
        );
        for region in [
            "",
            "US-EAST-1",
            "us-east",
            "us-1",
            "us--east-1",
            "us-east-12",
            "us-east-1/path",
        ] {
            assert!(
                kiro_organization_request("https://d-example.awsapps.com/start", region).is_err(),
                "accepted {region}"
            );
        }
        assert!(
            kiro_organization_request("https://d-example.awsapps.com/start", "us-east-1\n")
                .is_err()
        );
    }

    #[test]
    fn generic_oauth_is_serialized_per_provider_while_codex_is_per_account() {
        let first = ReauthControl {
            provider: "kiro".into(),
            id: "a".into(),
        };
        let second = ReauthControl {
            provider: "kiro".into(),
            id: "b".into(),
        };
        let codex = ReauthControl {
            provider: "openai".into(),
            id: "a".into(),
        };
        assert_eq!(reauth_mutation_key(&first), reauth_mutation_key(&second));
        assert_ne!(reauth_mutation_key(&first), reauth_mutation_key(&codex));
    }

    #[test]
    fn oauth_reauth_waits_for_current_flow_completion_and_surfaces_failures() {
        assert!(!oauth_auth_finished(&AuthStatusResponse {
            logged_in: true,
            done: false,
            ..Default::default()
        }));
        assert!(oauth_auth_finished(&AuthStatusResponse {
            logged_in: true,
            done: true,
            ..Default::default()
        }));
        assert!(auth_failed(&AuthStatusResponse {
            status: Some("FAILED".into()),
            message: Some("denied".into()),
            ..Default::default()
        })
        .is_some());
    }

    #[test]
    fn action_follows_short_identity_and_stays_before_health_column() {
        let rect = account_action_rect(DEFAULT_WIDTH, 120, 96, false);
        assert_eq!(rect.left, ACCOUNT_IDENTITY_LEFT + 96 + ACCOUNT_ACTION_GAP);
        assert_eq!(rect.right - rect.left, ACCOUNT_ACTION_WIDTH);
        assert!(rect.right <= DEFAULT_WIDTH - 244);
    }

    #[test]
    fn play_triangle_points_right_with_the_apex_on_the_right() {
        let columns = play_triangle_columns(20, 30, 7, 5);
        assert_eq!(columns.len(), 7);
        // Flat edge on the left, 1px apex on the right (standard play ▶).
        let heights: Vec<i32> = columns.iter().map(|rect| rect.bottom - rect.top).collect();
        assert_eq!(heights[0], 11);
        assert_eq!(heights[6], 1);
        assert!(heights.windows(2).all(|pair| pair[0] >= pair[1]));
        assert!(columns[0].left < columns[6].left);
        assert_eq!(columns[0].left, 20);
        assert_eq!(columns[6].right, 20 + 6 + 2);
    }

    #[test]
    fn long_identity_cannot_push_action_into_health_column() {
        let rect = account_action_rect(DEFAULT_WIDTH, 120, 2_000, false);
        assert_eq!(rect.right, DEFAULT_WIDTH - 244 - ACCOUNT_ACTION_GAP);
    }

    #[test]
    fn ticket_badge_sits_after_play_pause_and_before_health() {
        let action = account_action_rect(DEFAULT_WIDTH, 120, 2_000, true);
        let ticket = reset_credit_action_rect(action);

        assert_eq!(ticket.left, action.right + ACCOUNT_ACTION_GAP);
        assert_eq!(ticket.right - ticket.left, RESET_CREDIT_ACTION_WIDTH);
        assert!(ticket.right <= DEFAULT_WIDTH - 244);
        assert_eq!(ticket.top, action.top);
        assert_eq!(ticket.bottom, action.bottom);
    }

    #[test]
    fn reset_credit_dates_are_compact_and_explicitly_utc() {
        assert_eq!(
            format_credit_timestamp("2026-09-21T00:27:48.432665Z"),
            "2026.09.21 00:27 UTC"
        );
        assert_eq!(format_credit_timestamp("unknown"), "unknown");
    }

    #[test]
    fn log_age_uses_compact_relative_units() {
        let now = 10_000_000;
        assert_eq!(format_log_age_at(now - 2_000, now), "방금");
        assert_eq!(format_log_age_at(now - 42_000, now), "42초 전");
        assert_eq!(format_log_age_at(now - 180_000, now), "3분 전");
        assert_eq!(format_log_age_at(now - 7_200_000, now), "2시간 전");
    }

    #[test]
    fn provider_display_keeps_no_quota_views_and_orders_quota_first() {
        let providers = vec![
            ProviderView {
                name: "usage-only".into(),
                accounts: vec![AccountView {
                    id: "oauth-account".into(),
                    kind: "oauth".into(),
                    ..Default::default()
                }],
                ..Default::default()
            },
            ProviderView {
                name: "with-quota".into(),
                quota: Some(Quota {
                    weekly_percent: Some(50.0),
                    ..Default::default()
                }),
                ..Default::default()
            },
            ProviderView {
                name: "no-report".into(),
                ..Default::default()
            },
        ];

        let ordered = ordered_provider_views(&providers);
        let names: Vec<&str> = ordered
            .iter()
            .map(|provider| provider.name.as_str())
            .collect();

        assert_eq!(names, vec!["with-quota", "usage-only", "no-report"]);
        assert_eq!(ordered[1].accounts[0].id, "oauth-account");
    }

    #[test]
    fn weekly_provider_quota_renders_without_a_monthly_spend_row() {
        let reset_at = 1_785_945_600_000.0;
        let quota = Quota {
            weekly_percent: Some(100.0),
            weekly_reset_at: Some(reset_at),
            ..Default::default()
        };

        let rows = quota_rows(Some(&quota));

        assert_eq!(rows.len(), 1);
        assert_eq!(rows[0].label, "Weekly");
        assert_eq!(rows[0].percent, 100.0);
        assert_eq!(rows[0].reset_at, Some(reset_at));
    }

    #[test]
    fn value_label_windows_render_as_text_rows() {
        let quota = Quota {
            custom_windows: vec![QuotaWindow {
                label: "추산 비용 · 30일".into(),
                percent: Some(0.0),
                reset_at: None,
                value_label: Some("~$8.48".into()),
                segments: Vec::new(),
            }],
            ..Default::default()
        };

        let rows = quota_rows(Some(&quota));

        assert_eq!(rows.len(), 1);
        assert_eq!(rows[0].label, "추산 비용 · 30일");
        assert_eq!(rows[0].percent, 0.0);
        assert_eq!(rows[0].value_label.as_deref(), Some("~$8.48"));

        let columns = quota_columns(Some(&quota));
        assert_eq!(columns.len(), 1);
        assert_eq!(columns[0].value_label.as_deref(), Some("~$8.48"));
    }

    #[test]
    fn segment_windows_become_one_row_with_three_narrow_bars() {
        let quota = Quota {
            custom_windows: vec![QuotaWindow {
                label: "할당량".into(),
                percent: Some(0.0),
                reset_at: None,
                value_label: None,
                segments: vec![
                    QuotaSegment {
                        label: "5h".into(),
                        percent: Some(8.4),
                        reset_at: Some(1_785_945_600_000.0),
                    },
                    QuotaSegment {
                        label: "Weekly".into(),
                        percent: Some(3.36),
                        reset_at: Some(1_785_945_600_000.0),
                    },
                    QuotaSegment {
                        label: "Monthly".into(),
                        percent: Some(33.9),
                        reset_at: None,
                    },
                ],
            }],
            ..Default::default()
        };

        let rows = quota_rows(Some(&quota));

        assert_eq!(rows.len(), 1);
        assert_eq!(rows[0].label, "할당량");
        assert_eq!(rows[0].segments.len(), 3);
        assert_eq!(rows[0].segments[1].label, "Weekly");
        assert_eq!(rows[0].segments[1].percent, Some(3.36));
        assert_eq!(rows[0].segments[2].label, "Monthly");
        assert_eq!(rows[0].segments[2].reset_at, None);

        let columns = quota_columns(Some(&quota));
        assert_eq!(columns.len(), 3);
        assert_eq!(columns[0].label, "5h");
        assert_eq!(columns[1].label, "Weekly");
        assert_eq!(columns[2].label, "Monthly");
    }

    #[test]
    fn standard_and_custom_api_windows_share_one_dynamic_column_row() {
        let quota = Quota {
            five_hour_percent: Some(12.0),
            five_hour_reset_at: Some(1_785_945_600_000.0),
            weekly_percent: Some(34.0),
            monthly_percent: Some(56.0),
            custom_windows: vec![QuotaWindow {
                label: "API window".into(),
                percent: Some(78.0),
                reset_at: None,
                value_label: None,
                segments: Vec::new(),
            }],
            ..Default::default()
        };

        let columns = quota_columns(Some(&quota));
        assert_eq!(
            columns
                .iter()
                .map(|column| column.label.as_str())
                .collect::<Vec<_>>(),
            vec!["5h", "Weekly", "Monthly", "API window"]
        );
        assert_eq!(
            columns
                .iter()
                .map(|column| column.percent)
                .collect::<Vec<_>>(),
            vec![Some(12.0), Some(34.0), Some(56.0), Some(78.0)]
        );
        assert_eq!(account_height(&AccountView::default()), 38);
        assert_eq!(
            account_height(&AccountView {
                quota: Some(quota),
                ..Default::default()
            }),
            60
        );
    }

    #[test]
    fn clamps_an_offscreen_window_into_the_work_area() {
        let work = RECT {
            left: 0,
            top: 0,
            right: 1920,
            bottom: 1040,
        };
        assert_eq!(
            clamp_window_to_work_area(2200, -700, 525, 58, work),
            (1395, 0, 525, 58)
        );
    }

    #[test]
    fn preserves_negative_coordinates_on_an_upper_monitor() {
        let work = RECT {
            left: 0,
            top: -1080,
            right: 1920,
            bottom: 0,
        };
        assert_eq!(
            clamp_window_to_work_area(1366, -649, 525, 58, work),
            (1366, -649, 525, 58)
        );
    }

    #[test]
    fn shrinks_an_oversized_window_to_the_available_work_area() {
        let work = RECT {
            left: -1280,
            top: 0,
            right: 0,
            bottom: 720,
        };
        assert_eq!(
            clamp_window_to_work_area(-2000, 900, 1600, 900, work),
            (-1280, 0, 1280, 720)
        );
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

unsafe fn revive_existing_window(hwnd: HWND) {
    let mut rect = RECT::default();
    let _ = GetWindowRect(hwnd, &mut rect);
    let width = (rect.right - rect.left).clamp(MIN_WIDTH, MAX_WIDTH);
    let height = (rect.bottom - rect.top).max(COLLAPSED_HEIGHT);
    let mut point = POINT::default();
    let _ = GetCursorPos(&mut point);
    let monitor = MonitorFromPoint(point, MONITOR_DEFAULTTOPRIMARY);
    let mut info = MONITORINFO {
        cbSize: size_of::<MONITORINFO>() as u32,
        ..Default::default()
    };
    let _ = GetMonitorInfoW(monitor, &mut info);
    let desired_x = info.rcWork.left + (info.rcWork.right - info.rcWork.left - width) / 2;
    let desired_y = info.rcWork.top + 6;
    let (x, y, width, height) =
        clamp_window_to_work_area(desired_x, desired_y, width, height, info.rcWork);
    let _ = SetLayeredWindowAttributes(hwnd, COLORREF(0), 238, LWA_ALPHA);
    let _ = ShowWindow(hwnd, SW_SHOWNOACTIVATE);
    let _ = SetWindowPos(
        hwnd,
        HWND_TOPMOST,
        x,
        y,
        width,
        height,
        SWP_NOACTIVATE | SWP_SHOWWINDOW,
    );
    let _ = InvalidateRect(hwnd, None, true);
    let _ = UpdateWindow(hwnd);
    save_window_placement(hwnd);
}

unsafe fn recover_window_after_display_change(hwnd: HWND) {
    let mut rect = RECT::default();
    if GetWindowRect(hwnd, &mut rect).is_err() {
        return;
    }
    let monitor = MonitorFromRect(&rect, MONITOR_DEFAULTTONEAREST);
    let mut info = MONITORINFO {
        cbSize: size_of::<MONITORINFO>() as u32,
        ..Default::default()
    };
    let _ = GetMonitorInfoW(monitor, &mut info);
    let (x, y, width, height) = clamp_window_to_work_area(
        rect.left,
        rect.top,
        rect.right - rect.left,
        rect.bottom - rect.top,
        info.rcWork,
    );
    let _ = SetLayeredWindowAttributes(hwnd, COLORREF(0), 238, LWA_ALPHA);
    let _ = SetWindowPos(
        hwnd,
        HWND_TOPMOST,
        x,
        y,
        width,
        height,
        SWP_NOACTIVATE | SWP_SHOWWINDOW,
    );
    apply_round_region(hwnd, width, height);
    let _ = InvalidateRect(hwnd, None, true);
    save_window_placement(hwnd);
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
            "사용 안 함".to_string()
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
        w!("자동 전환 기준"),
    );
    let _ = AppendMenuW(menu, MF_STRING, MENU_THRESHOLD_DOWN, w!("기준값 -1%"));
    let _ = AppendMenuW(menu, MF_STRING, MENU_THRESHOLD_UP, w!("기준값 +1%"));
    let _ = AppendMenuW(menu, MF_SEPARATOR, 0, None);
    let _ = AppendMenuW(menu, MF_STRING, MENU_PROVIDER_ADD, w!("프로바이더 추가..."));
    let _ = AppendMenuW(menu, MF_SEPARATOR, 0, None);
    let _ = AppendMenuW(menu, MF_STRING, MENU_CONNECTION, w!("연결 설정..."));
    let _ = AppendMenuW(menu, MF_SEPARATOR, 0, None);
    let _ = AppendMenuW(menu, MF_STRING, MENU_REFRESH, w!("새로고침"));
    let _ = AppendMenuW(menu, MF_SEPARATOR, 0, None);
    let _ = AppendMenuW(menu, MF_STRING, MENU_EXIT, w!("종료"));
    let mut point = POINT::default();
    let _ = GetCursorPos(&mut point);
    let _ = SetForegroundWindow(hwnd);
    with_app(|app| app.context_menu_open = true);
    let _ = TrackPopupMenu(menu, TPM_RIGHTBUTTON, point.x, point.y, 0, hwnd, None);
    with_app(|app| app.context_menu_open = false);
    let _ = DestroyMenu(menu);
    resize_for_state(hwnd);
    let _ = InvalidateRect(hwnd, None, false);
}
