# Native wrappers & home-screen widgets (Phase 10 — optional, future work)

**A Progressive Web App cannot create a home-screen widget** on Android or
iOS. Widgets require a small native app. The files in this folder are
*reference source* for that future step — they are not a buildable project
and are not used by the web app.

The design keeps the same privacy rule as notifications: **the widget only
ever shows the word "Reminder"**. It never reads, caches or displays message
content, and it needs no access to the server at all. Tapping it opens the
private web app, which still requires the normal login.

| Platform | Wrapper | Widget technology | Reference file |
| --- | --- | --- | --- |
| Android | Trusted Web Activity (open-source [Bubblewrap](https://github.com/GoogleChromeLabs/bubblewrap)) or a minimal Kotlin WebView app | Jetpack Glance (App Widgets) | [`android/ReminderWidget.kt`](android/ReminderWidget.kt) |
| iPhone | Minimal Swift app with `WKWebView` (or simply the Home Screen PWA) | WidgetKit (SwiftUI) | [`ios/ReminderWidget.swift`](ios/ReminderWidget.swift) |

## Android outline

1. Generate a TWA wrapper for `https://your-domain/` with Bubblewrap, or
   create an Android Studio project with an `Activity` hosting the site.
2. Add `androidx.glance:glance-appwidget` and the `ReminderWidget` /
   `ReminderWidgetReceiver` classes from `android/ReminderWidget.kt`.
3. Register the receiver in `AndroidManifest.xml` with an
   `appwidget-provider` XML (`res/xml/reminder_widget_info.xml`).
4. The widget opens the wrapper activity, which loads the PWA.

If you want the widget to reflect *whether* something new is waiting, do it
without content: the native app may hold a boolean (e.g. set when a push
arrives) and still render only "Reminder" — for example with a small dot.

## iPhone outline

1. Create an Xcode project (App + Widget Extension).
2. The app target hosts a `WKWebView` pointing to `https://your-domain/`
   (or just opens the URL in Safari for the Home Screen PWA).
3. Replace the generated widget with `ios/ReminderWidget.swift`.
4. Set the widget's `widgetURL` to the app's URL scheme so tapping it opens
   the app.

Web Push for the Home Screen PWA already works on iOS 16.4+, so a native
wrapper is only needed for the widget.
