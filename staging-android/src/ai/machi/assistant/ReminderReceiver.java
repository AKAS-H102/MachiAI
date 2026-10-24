package ai.machi.assistant;

import android.content.BroadcastReceiver;
import android.content.Context;
import android.content.Intent;

/** Fires when a reminder's alarm goes off, even if the app is closed. */
public class ReminderReceiver extends BroadcastReceiver {
    @Override
    public void onReceive(Context context, Intent intent) {
        String id = intent.getStringExtra("id");
        String title = intent.getStringExtra("title");
        if (id == null) return;
        ReminderUtil.notifyNow(context, id, title == null || title.isEmpty() ? "Your reminder" : title);
        ReminderUtil.markFired(context, id);
    }
}
