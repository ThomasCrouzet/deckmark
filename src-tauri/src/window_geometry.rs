//! Work-area constraints for the native Desktop windows.
//!
//! The configuration sizes are logical pixels. A high display scale or a small
//! screen can make the monitor work area smaller than those defaults. The
//! helpers below keep every window inside the work area of its current monitor.

#[cfg(feature = "native-smoke")]
use serde::Serialize;
#[cfg(feature = "native-smoke")]
use tauri::Manager;
use tauri::{LogicalPosition, LogicalSize, Monitor, PhysicalPosition, PhysicalSize, WebviewWindow};

/// Space kept between a window and the work-area edge, in logical pixels.
const EDGE_MARGIN: f64 = 8.0;

/// Smallest main-window size that still keeps the shell scrollable.
pub const MAIN_MINIMUM: (f64, f64) = (320.0, 240.0);
/// Smallest quick-capture size. The body and footer keep their own scroll.
pub const CAPTURE_MINIMUM: (f64, f64) = (320.0, 240.0);

/// A rectangle in logical pixels, relative to the virtual desktop.
#[derive(Clone, Copy, Debug, PartialEq)]
pub struct WorkArea {
    pub x: f64,
    pub y: f64,
    pub width: f64,
    pub height: f64,
}

impl WorkArea {
    /// Converts a monitor work area from physical to logical pixels.
    pub fn from_monitor(monitor: &Monitor) -> Self {
        let scale = valid_scale(monitor.scale_factor());
        let area = monitor.work_area();
        Self {
            x: area.position.x as f64 / scale,
            y: area.position.y as f64 / scale,
            width: area.size.width as f64 / scale,
            height: area.size.height as f64 / scale,
        }
    }

    /// Fits a preferred content size into the work area and keeps the minimum
    /// usable. Use this form for a frameless window, whose decoration is zero.
    pub fn fit(&self, preferred: (f64, f64), minimum: (f64, f64)) -> (f64, f64) {
        self.fit_decorated(preferred, minimum, (0.0, 0.0))
    }

    /// Fits a preferred content size into the work area after subtracting the
    /// window decoration. The decoration is the measured outer minus inner
    /// size, so a title bar or frame also counts against the usable area.
    pub fn fit_decorated(
        &self,
        preferred: (f64, f64),
        minimum: (f64, f64),
        decoration: (f64, f64),
    ) -> (f64, f64) {
        let decoration = clamp_decoration(decoration);
        let available_width = (self.width - 2.0 * EDGE_MARGIN - decoration.0).max(1.0);
        let available_height = (self.height - 2.0 * EDGE_MARGIN - decoration.1).max(1.0);
        let minimum_width = minimum.0.min(available_width);
        let minimum_height = minimum.1.min(available_height);
        (
            preferred.0.clamp(minimum_width, available_width),
            preferred.1.clamp(minimum_height, available_height),
        )
    }

    /// Returns the minimum size that the work area can hold.
    pub fn minimum(&self, requested: (f64, f64)) -> (f64, f64) {
        self.minimum_decorated(requested, (0.0, 0.0))
    }

    /// Returns the minimum content size that the work area can hold after the
    /// decoration is subtracted.
    pub fn minimum_decorated(&self, requested: (f64, f64), decoration: (f64, f64)) -> (f64, f64) {
        let decoration = clamp_decoration(decoration);
        (
            requested
                .0
                .min((self.width - 2.0 * EDGE_MARGIN - decoration.0).max(1.0)),
            requested
                .1
                .min((self.height - 2.0 * EDGE_MARGIN - decoration.1).max(1.0)),
        )
    }

    /// Clamps a window origin so the window stays fully inside the work area.
    pub fn clamp_position(&self, position: (f64, f64), size: (f64, f64)) -> (f64, f64) {
        let min_x = self.x + EDGE_MARGIN;
        let min_y = self.y + EDGE_MARGIN;
        let max_x = (self.x + self.width - size.0 - EDGE_MARGIN).max(min_x);
        let max_y = (self.y + self.height - size.1 - EDGE_MARGIN).max(min_y);
        (
            position.0.clamp(min_x, max_x),
            position.1.clamp(min_y, max_y),
        )
    }

    /// Returns the origin that centers a window in the work area.
    pub fn centered_position(&self, size: (f64, f64)) -> (f64, f64) {
        let position = (
            self.x + (self.width - size.0) / 2.0,
            self.y + (self.height - size.1) / 2.0,
        );
        self.clamp_position(position, size)
    }

    /// Reports whether a rectangle is fully inside the work area.
    pub fn contains(&self, position: (f64, f64), size: (f64, f64)) -> bool {
        position.0 >= self.x
            && position.1 >= self.y
            && position.0 + size.0 <= self.x + self.width
            && position.1 + size.1 <= self.y + self.height
    }

    /// Plans the size and origin for one window.
    ///
    /// The decoration is the measured outer minus inner size at one moment.
    /// It counts against the usable work area. A maximized window keeps its
    /// size and origin, because a resize would restore it to the normal state.
    pub fn plan_window(
        &self,
        preferred: (f64, f64),
        minimum: (f64, f64),
        decoration: (f64, f64),
        position: (f64, f64),
        maximized: bool,
    ) -> WindowPlan {
        let decoration = clamp_decoration(decoration);
        if maximized {
            return WindowPlan {
                inner: preferred,
                outer: (preferred.0 + decoration.0, preferred.1 + decoration.1),
                position,
                resize: false,
                reposition: false,
            };
        }
        let inner = self.fit_decorated(preferred, minimum, decoration);
        let outer = (inner.0 + decoration.0, inner.1 + decoration.1);
        let resize = (preferred.0 - inner.0).abs() > 0.5 || (preferred.1 - inner.1).abs() > 0.5;
        let target = if resize {
            self.centered_position(outer)
        } else if !self.contains(position, outer) {
            self.clamp_position(position, outer)
        } else {
            position
        };
        let reposition = (position.0 - target.0).abs() > 0.5 || (position.1 - target.1).abs() > 0.5;
        WindowPlan {
            inner,
            outer,
            position: target,
            resize,
            reposition,
        }
    }
}

/// The platform actions needed to keep one window inside its work area.
#[derive(Clone, Copy, Debug, PartialEq)]
pub struct WindowPlan {
    /// Inner content size to request from the platform.
    pub inner: (f64, f64),
    /// Outer size, including the decoration.
    pub outer: (f64, f64),
    /// Outer top-left origin inside the work area.
    pub position: (f64, f64),
    /// Whether the size differs from the preferred inner size.
    pub resize: bool,
    /// Whether the origin differs from the current origin.
    pub reposition: bool,
}

fn clamp_decoration(decoration: (f64, f64)) -> (f64, f64) {
    (decoration.0.max(0.0), decoration.1.max(0.0))
}

/// Returns the decoration size measured from one inner and outer sample.
pub fn decoration_size(inner: (f64, f64), outer: (f64, f64)) -> (f64, f64) {
    clamp_decoration((outer.0 - inner.0, outer.1 - inner.1))
}

/// Returns the minimum content size for a window label.
pub fn minimum_for(label: &str) -> (f64, f64) {
    if label == "capture" {
        CAPTURE_MINIMUM
    } else {
        MAIN_MINIMUM
    }
}

fn valid_scale(scale: f64) -> f64 {
    if scale.is_finite() && scale > 0.0 {
        scale
    } else {
        1.0
    }
}

fn monitor_for(window: &WebviewWindow) -> Result<Monitor, String> {
    if let Some(monitor) = window
        .current_monitor()
        .map_err(|error| error.to_string())?
    {
        return Ok(monitor);
    }
    window
        .primary_monitor()
        .map_err(|error| error.to_string())?
        .ok_or_else(|| "No monitor is available.".to_string())
}

/// Shrinks and repositions a window so it stays inside its monitor work area.
///
/// The call is idempotent. It runs on window creation, on a capture-window
/// reuse and after a display scale change. A maximized window is left in place.
pub fn constrain_window(window: &WebviewWindow, minimum: (f64, f64)) -> Result<(), String> {
    let monitor = monitor_for(window)?;
    let area = WorkArea::from_monitor(&monitor);
    let scale = valid_scale(window.scale_factor().map_err(|error| error.to_string())?);
    // Read the inner and outer sizes together before a resize. The outer size
    // includes the decoration, so the difference is the decoration width and
    // height that also has to fit inside the work area.
    let inner: PhysicalSize<u32> = window.inner_size().map_err(|error| error.to_string())?;
    let outer: PhysicalSize<u32> = window.outer_size().map_err(|error| error.to_string())?;
    let position: PhysicalPosition<i32> =
        window.outer_position().map_err(|error| error.to_string())?;
    let preferred = (inner.width as f64 / scale, inner.height as f64 / scale);
    let decoration = decoration_size(
        preferred,
        (outer.width as f64 / scale, outer.height as f64 / scale),
    );
    let maximized = window.is_maximized().map_err(|error| error.to_string())?;
    let plan = area.plan_window(
        preferred,
        minimum,
        decoration,
        (position.x as f64 / scale, position.y as f64 / scale),
        maximized,
    );

    if plan.resize {
        window
            .set_size(LogicalSize::new(plan.inner.0, plan.inner.1))
            .map_err(|error| error.to_string())?;
    }
    if plan.reposition {
        window
            .set_position(LogicalPosition::new(plan.position.0, plan.position.1))
            .map_err(|error| error.to_string())?;
    }
    let (min_width, min_height) = area.minimum_decorated(minimum, decoration);
    window
        .set_min_size(Some(LogicalSize::new(min_width, min_height)))
        .map_err(|error| error.to_string())?;
    Ok(())
}

/// Fits and recenters the quick-capture window before it becomes visible.
pub fn constrain_capture(window: &WebviewWindow) -> Result<(), String> {
    constrain_window(window, CAPTURE_MINIMUM)?;
    if window.is_maximized().map_err(|error| error.to_string())? {
        return Ok(());
    }
    let monitor = monitor_for(window)?;
    let area = WorkArea::from_monitor(&monitor);
    let scale = valid_scale(window.scale_factor().map_err(|error| error.to_string())?);
    let inner: PhysicalSize<u32> = window.inner_size().map_err(|error| error.to_string())?;
    let outer: PhysicalSize<u32> = window.outer_size().map_err(|error| error.to_string())?;
    let size = (inner.width as f64 / scale, inner.height as f64 / scale);
    let decoration = decoration_size(
        size,
        (outer.width as f64 / scale, outer.height as f64 / scale),
    );
    let (target_x, target_y) =
        area.centered_position((size.0 + decoration.0, size.1 + decoration.1));
    window
        .set_position(LogicalPosition::new(target_x, target_y))
        .map_err(|error| error.to_string())
}

/// Read-only geometry evidence for the native smoke workflow.
#[cfg(feature = "native-smoke")]
#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct GeometryEvidence {
    pub label: String,
    pub monitor_name: Option<String>,
    pub scale_factor: f64,
    pub work_area: Rect,
    pub work_area_logical: Rect,
    pub monitor_size: Rect,
    pub inner_size: Size,
    pub inner_size_logical: Size,
    pub outer_size: Size,
    pub outer_position: Position,
    pub fitted_size: Size,
    pub is_maximized: bool,
}

#[cfg(feature = "native-smoke")]
#[derive(Debug, Serialize)]
pub struct Rect {
    pub x: i32,
    pub y: i32,
    pub width: u32,
    pub height: u32,
}

#[cfg(feature = "native-smoke")]
#[derive(Debug, Serialize)]
pub struct Size {
    pub width: u32,
    pub height: u32,
}

#[cfg(feature = "native-smoke")]
#[derive(Debug, Serialize)]
pub struct Position {
    pub x: i32,
    pub y: i32,
}

/// Returns the monitor work area and the window bounds for one window.
#[cfg(feature = "native-smoke")]
#[tauri::command]
pub fn desktop_window_geometry(
    window: WebviewWindow,
    label: Option<String>,
) -> Result<GeometryEvidence, String> {
    let window = match label {
        Some(label) if label != window.label() => window
            .app_handle()
            .get_webview_window(&label)
            .ok_or_else(|| format!("The {label} window is unavailable."))?,
        _ => window,
    };
    let monitor = monitor_for(&window)?;
    let area = WorkArea::from_monitor(&monitor);
    let scale = valid_scale(window.scale_factor().map_err(|error| error.to_string())?);
    let work = monitor.work_area();
    let inner = window.inner_size().map_err(|error| error.to_string())?;
    let outer = window.outer_size().map_err(|error| error.to_string())?;
    let position = window.outer_position().map_err(|error| error.to_string())?;
    let preference = (inner.width as f64 / scale, inner.height as f64 / scale);
    let decoration = decoration_size(
        preference,
        (outer.width as f64 / scale, outer.height as f64 / scale),
    );
    let (fitted_width, fitted_height) =
        area.fit_decorated(preference, minimum_for(window.label()), decoration);
    Ok(GeometryEvidence {
        label: window.label().to_string(),
        monitor_name: monitor.name().cloned(),
        scale_factor: scale,
        work_area: Rect {
            x: work.position.x,
            y: work.position.y,
            width: work.size.width,
            height: work.size.height,
        },
        work_area_logical: Rect {
            x: area.x.round() as i32,
            y: area.y.round() as i32,
            width: area.width.round() as u32,
            height: area.height.round() as u32,
        },
        monitor_size: Rect {
            x: monitor.position().x,
            y: monitor.position().y,
            width: monitor.size().width,
            height: monitor.size().height,
        },
        inner_size: Size {
            width: inner.width,
            height: inner.height,
        },
        inner_size_logical: Size {
            width: (inner.width as f64 / scale).round() as u32,
            height: (inner.height as f64 / scale).round() as u32,
        },
        outer_size: Size {
            width: outer.width,
            height: outer.height,
        },
        outer_position: Position {
            x: position.x,
            y: position.y,
        },
        fitted_size: Size {
            width: fitted_width.round() as u32,
            height: fitted_height.round() as u32,
        },
        is_maximized: window.is_maximized().map_err(|error| error.to_string())?,
    })
}

#[cfg(test)]
mod tests {
    use super::*;

    fn high_scale_small_screen() -> WorkArea {
        WorkArea {
            x: 0.0,
            y: 0.0,
            width: 683.0,
            height: 384.0,
        }
    }

    #[test]
    fn fits_the_main_default_into_a_high_scale_work_area() {
        let area = high_scale_small_screen();
        let (width, height) = area.fit((1280.0, 800.0), MAIN_MINIMUM);
        assert!(width <= 683.0 - 2.0 * EDGE_MARGIN);
        assert!(height <= 384.0 - 2.0 * EDGE_MARGIN);
        assert!(width >= MAIN_MINIMUM.0);
        assert!(height >= MAIN_MINIMUM.1);
    }

    #[test]
    fn fits_the_capture_window_into_a_short_work_area() {
        let area = high_scale_small_screen();
        let (width, height) = area.fit((560.0, 420.0), CAPTURE_MINIMUM);
        assert_eq!(width, 560.0);
        assert!(height < 384.0);
        assert!(height >= CAPTURE_MINIMUM.1);
    }

    #[test]
    fn keeps_the_default_size_on_a_large_work_area() {
        let area = WorkArea {
            x: 0.0,
            y: 0.0,
            width: 2560.0,
            height: 1440.0,
        };
        assert_eq!(area.fit((1280.0, 800.0), MAIN_MINIMUM), (1280.0, 800.0));
        assert_eq!(area.fit((560.0, 420.0), CAPTURE_MINIMUM), (560.0, 420.0));
    }

    #[test]
    fn reduces_the_minimum_below_the_work_area() {
        let area = WorkArea {
            x: 0.0,
            y: 0.0,
            width: 260.0,
            height: 180.0,
        };
        assert_eq!(area.minimum(MAIN_MINIMUM), (244.0, 164.0));
        let (width, height) = area.fit(MAIN_MINIMUM, MAIN_MINIMUM);
        assert!(width <= 244.0);
        assert!(height <= 164.0);
    }

    #[test]
    fn clamps_a_window_origin_inside_the_work_area() {
        let area = high_scale_small_screen();
        assert_eq!(
            area.clamp_position((-100.0, 900.0), (300.0, 200.0)),
            (8.0, 176.0)
        );
        assert_eq!(
            area.clamp_position((400.0, 100.0), (300.0, 200.0)),
            (375.0, 100.0)
        );
    }

    #[test]
    fn centers_a_window_inside_the_work_area() {
        let area = high_scale_small_screen();
        assert_eq!(area.centered_position((300.0, 200.0)), (191.5, 92.0));
        assert_eq!(area.centered_position((600.0, 300.0)), (41.5, 42.0));
    }

    #[test]
    fn reports_containment() {
        let area = high_scale_small_screen();
        assert!(area.contains((8.0, 8.0), (667.0, 368.0)));
        assert!(!area.contains((100.0, 300.0), (667.0, 368.0)));
        assert!(!area.contains((-1.0, 0.0), (100.0, 100.0)));
    }

    #[test]
    fn fits_a_decorated_window_inside_the_work_area() {
        let area = high_scale_small_screen();
        let plan = area.plan_window(
            (1280.0, 800.0),
            MAIN_MINIMUM,
            (0.0, 30.0),
            (0.0, 0.0),
            false,
        );
        assert_eq!(plan.inner, (667.0, 338.0));
        assert_eq!(plan.outer, (667.0, 368.0));
        assert_eq!(plan.position, (8.0, 8.0));
        assert!(plan.resize);
        assert!(plan.reposition);
        assert!(area.contains(plan.position, plan.outer));
    }

    #[test]
    fn keeps_a_maximized_window_size_and_origin() {
        let area = high_scale_small_screen();
        let plan = area.plan_window((683.0, 384.0), MAIN_MINIMUM, (0.0, 30.0), (0.0, 0.0), true);
        assert!(!plan.resize);
        assert!(!plan.reposition);
        assert_eq!(plan.inner, (683.0, 384.0));
        assert_eq!(plan.position, (0.0, 0.0));
    }

    #[test]
    fn keeps_a_window_that_already_fits() {
        let area = high_scale_small_screen();
        let plan = area.plan_window(
            (600.0, 300.0),
            MAIN_MINIMUM,
            (0.0, 30.0),
            (40.0, 40.0),
            false,
        );
        assert!(!plan.resize);
        assert!(!plan.reposition);
        assert_eq!(plan.position, (40.0, 40.0));
    }

    #[test]
    fn clamps_a_decorated_window_origin_inside_the_work_area() {
        let area = high_scale_small_screen();
        let plan = area.plan_window(
            (667.0, 338.0),
            MAIN_MINIMUM,
            (0.0, 30.0),
            (900.0, 900.0),
            false,
        );
        assert!(!plan.resize);
        assert!(plan.reposition);
        assert_eq!(plan.outer, (667.0, 368.0));
        assert_eq!(plan.position, (8.0, 8.0));
        assert!(area.contains(plan.position, plan.outer));
    }

    #[test]
    fn keeps_a_decorated_window_inside_a_negative_origin_work_area() {
        let area = WorkArea {
            x: -683.0,
            y: -384.0,
            width: 683.0,
            height: 384.0,
        };
        let plan = area.plan_window(
            (1280.0, 800.0),
            MAIN_MINIMUM,
            (0.0, 30.0),
            (-683.0, -384.0),
            false,
        );
        assert_eq!(plan.inner, (667.0, 338.0));
        assert_eq!(plan.position, (-675.0, -376.0));
        assert!(area.contains(plan.position, plan.outer));
    }

    #[test]
    fn counts_the_decoration_against_the_minimum() {
        let area = WorkArea {
            x: 0.0,
            y: 0.0,
            width: 260.0,
            height: 180.0,
        };
        assert_eq!(
            area.minimum_decorated(MAIN_MINIMUM, (10.0, 20.0)),
            (234.0, 144.0)
        );
        assert_eq!(
            area.fit_decorated(MAIN_MINIMUM, MAIN_MINIMUM, (10.0, 20.0)),
            (234.0, 144.0)
        );
    }

    #[test]
    fn selects_the_minimum_from_the_window_label() {
        assert_eq!(minimum_for("main"), MAIN_MINIMUM);
        assert_eq!(minimum_for("capture"), CAPTURE_MINIMUM);
    }

    #[test]
    fn ignores_a_negative_decoration() {
        assert_eq!(decoration_size((300.0, 200.0), (280.0, 180.0)), (0.0, 0.0));
        assert_eq!(
            decoration_size((300.0, 200.0), (310.0, 230.0)),
            (10.0, 30.0)
        );
    }

    #[test]
    fn rejects_an_invalid_scale_factor() {
        assert_eq!(valid_scale(0.0), 1.0);
        assert_eq!(valid_scale(f64::NAN), 1.0);
        assert_eq!(valid_scale(2.0), 2.0);
    }
}
