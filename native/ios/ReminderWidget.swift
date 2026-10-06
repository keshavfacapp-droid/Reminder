// Reference implementation — WidgetKit home-screen widget.
// Shows only the word "Reminder". Never displays message content.
import SwiftUI
import WidgetKit

struct ReminderEntry: TimelineEntry {
    let date: Date
}

struct ReminderProvider: TimelineProvider {
    func placeholder(in context: Context) -> ReminderEntry { ReminderEntry(date: .now) }
    func getSnapshot(in context: Context, completion: @escaping (ReminderEntry) -> Void) {
        completion(ReminderEntry(date: .now))
    }
    func getTimeline(in context: Context, completion: @escaping (Timeline<ReminderEntry>) -> Void) {
        // Static content: nothing to refresh, nothing fetched from the server.
        completion(Timeline(entries: [ReminderEntry(date: .now)], policy: .never))
    }
}

struct ReminderWidgetView: View {
    var entry: ReminderEntry
    var body: some View {
        Text("Reminder")
            .font(.headline)
            .foregroundStyle(Color(red: 0.91, green: 0.90, blue: 0.88))
            .containerBackground(Color(red: 0.08, green: 0.09, blue: 0.10), for: .widget)
            // Opens the wrapper app (register this URL scheme in the app target).
            .widgetURL(URL(string: "reminder://open"))
    }
}

@main
struct ReminderWidget: Widget {
    var body: some WidgetConfiguration {
        StaticConfiguration(kind: "ReminderWidget", provider: ReminderProvider()) { entry in
            ReminderWidgetView(entry: entry)
        }
        .configurationDisplayName("Reminder")
        .description("Reminder")
        .supportedFamilies([.systemSmall])
    }
}
