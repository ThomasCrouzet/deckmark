#[tauri::command]
pub async fn desktop_print(
    window: tauri::WebviewWindow,
    title: String,
    page_width_points: Option<f64>,
    page_height_points: Option<f64>,
) -> Result<bool, String> {
    if window.label() != "main" {
        return Err("Printing requires the main window".into());
    }
    let page_size = match (page_width_points, page_height_points) {
        (None, None) => None,
        (Some(width), Some(height))
            if width.is_finite()
                && height.is_finite()
                && (72.0..=5760.0).contains(&width)
                && (72.0..=5760.0).contains(&height) =>
        {
            Some((width, height))
        }
        _ => {
            return Err(
                "Custom print dimensions must be a valid pair from 72 to 5760 points".into(),
            )
        }
    };
    #[cfg(target_os = "macos")]
    {
        use tauri::Manager;
        let (sender, receiver) = std::sync::mpsc::sync_channel(1);
        let app = window.app_handle().clone();
        window
            .with_webview(move |webview| {
                // Tauri runs this closure on the main thread and owns the WKWebView.
                if let Err(error) = unsafe {
                    macos::start(
                        &*webview.inner().cast(),
                        &title,
                        page_size,
                        sender.clone(),
                        app,
                    )
                } {
                    let _ = sender.send(Err(error));
                }
            })
            .map_err(|error| error.to_string())?;
        tauri::async_runtime::spawn_blocking(move || receiver.recv())
            .await
            .map_err(|error| error.to_string())?
            .map_err(|error| error.to_string())?
    }
    #[cfg(not(target_os = "macos"))]
    {
        let _ = title;
        let _ = page_size;
        window.print().map_err(|error| error.to_string())?;
        Ok(true)
    }
}

#[cfg(target_os = "macos")]
mod macos {
    use objc2::rc::Retained;
    use objc2::runtime::{Bool, NSObjectProtocol};
    use objc2::{define_class, msg_send, AnyThread, DefinedClass};
    use objc2_app_kit::{NSPaperOrientation, NSPrintInfo, NSPrintOperation};
    use objc2_foundation::{NSCopying, NSObject, NSSize};
    use std::cell::RefCell;
    use std::ffi::c_void;
    use std::sync::mpsc::SyncSender;

    thread_local! {
        static ACTIVE: RefCell<Option<Retained<PrintDelegate>>> = const { RefCell::new(None) };
    }

    struct PrintState {
        sender: SyncSender<Result<bool, String>>,
        app: tauri::AppHandle,
    }

    define_class!(
        #[unsafe(super(NSObject))]
        #[name = "MdshPrintDelegate"]
        #[ivars = PrintState]
        struct PrintDelegate;

        unsafe impl NSObjectProtocol for PrintDelegate {}

        impl PrintDelegate {
            #[unsafe(method(printOperationDidRun:success:context:))]
            fn did_run(&self, _operation: &NSPrintOperation, success: Bool, _context: *mut c_void) {
                let _keep_alive = unsafe { Retained::retain(self as *const Self as *mut Self) };
                let sender = self.ivars().sender.clone();
                let failure = sender.clone();
                let success = success.as_bool();
                #[cfg(feature = "native-smoke")]
                eprintln!("[mdsh-native-print] completed success={success} thread={:?}", std::thread::current().id());
                if let Err(error) = self.ivars().app.run_on_main_thread(move || {
                    ACTIVE.with(|active| active.borrow_mut().take());
                    let _ = sender.send(Ok(success));
                }) {
                    let _ = failure.send(Err(error.to_string()));
                }
            }
        }
    );

    pub unsafe fn start(
        view: &objc2_web_kit::WKWebView,
        title: &str,
        page_size: Option<(f64, f64)>,
        sender: SyncSender<Result<bool, String>>,
        app: tauri::AppHandle,
    ) -> Result<(), String> {
        if ACTIVE.with(|active| active.borrow().is_some()) {
            return Err("Printing is already active".into());
        }

        if !view.respondsToSelector(objc2::sel!(printOperationWithPrintInfo:)) {
            return Err("Native PDF printing requires macOS 11 or later".into());
        }
        // Do not change the user's shared printer settings.
        let info = NSPrintInfo::sharedPrintInfo().copy();
        let (page_width, page_height) =
            page_size.unwrap_or((210.0 * 72.0 / 25.4, 297.0 * 72.0 / 25.4));
        if page_width > page_height {
            info.setPaperSize(NSSize::new(page_height, page_width));
            info.setOrientation(NSPaperOrientation::Landscape);
        } else {
            info.setPaperSize(NSSize::new(page_width, page_height));
            info.setOrientation(NSPaperOrientation::Portrait);
        }
        if page_size.is_some() {
            info.setTopMargin(0.0);
            info.setBottomMargin(0.0);
            info.setLeftMargin(0.0);
            info.setRightMargin(0.0);
        } else {
            info.setTopMargin(18.0 * 72.0 / 25.4);
            info.setBottomMargin(22.0 * 72.0 / 25.4);
            info.setLeftMargin(16.0 * 72.0 / 25.4);
            info.setRightMargin(16.0 * 72.0 / 25.4);
        }
        info.setHorizontallyCentered(false);
        info.setVerticallyCentered(false);

        #[cfg(feature = "native-smoke")]
        let destination = std::env::var("MDSH_SMOKE_PDF").ok().filter(|_| {
            !std::env::var_os("MDSH_SMOKE_PRINT_PANEL")
                .is_some_and(|path| std::path::Path::new(&path).exists())
        });
        #[cfg(feature = "native-smoke")]
        if let Some(path) = &destination {
            use objc2_app_kit::{NSPrintJobSavingURL, NSPrintSaveJob};
            use objc2_foundation::{NSString, NSURL};
            info.setJobDisposition(NSPrintSaveJob);
            let url = NSURL::fileURLWithPath(&NSString::from_str(path));
            info.dictionary().setObject_forKey(
                &url,
                objc2::runtime::ProtocolObject::from_ref(NSPrintJobSavingURL),
            );
        }

        let operation = view.printOperationWithPrintInfo(&info);
        operation.setJobTitle(Some(&objc2_foundation::NSString::from_str(title)));
        #[cfg(feature = "native-smoke")]
        if destination.is_some() {
            operation.setShowsPrintPanel(false);
            operation.setShowsProgressPanel(false);
        }
        let window = view.window().ok_or("Print window is unavailable")?;
        let allocated = PrintDelegate::alloc().set_ivars(PrintState { sender, app });
        let delegate: Retained<PrintDelegate> = msg_send![super(allocated), init];
        ACTIVE.with(|active| *active.borrow_mut() = Some(delegate.clone()));
        operation.setCanSpawnSeparateThread(true);
        #[cfg(feature = "native-smoke")]
        eprintln!(
            "[mdsh-native-print] started thread={:?}",
            std::thread::current().id()
        );
        // Use an asynchronous sheet. Blocking the Tauri event loop can stop WKWebView
        // while it prepares a page. The callback controls DOM cleanup in the frontend.
        operation.runOperationModalForWindow_delegate_didRunSelector_contextInfo(
            &window,
            Some(&delegate),
            Some(objc2::sel!(printOperationDidRun:success:context:)),
            std::ptr::null_mut(),
        );
        Ok(())
    }
}
