package ai.machi.assistant;

import android.app.AlarmManager;
import android.app.Notification;
import android.app.NotificationChannel;
import android.app.NotificationManager;
import android.app.PendingIntent;
import android.content.Context;
import android.content.Intent;
import android.os.Build;
import android.util.Log;
import org.json.JSONArray;
import org.json.JSONObject;

/**
 * Reminders that really fire: stored on the phone, scheduled with AlarmManager.setAlarmClock (exact, works in Doze,
 * needs no special permission) and shown as a high-priority notification. Re-scheduled after a reboot / app update.
 */
public final class ReminderUtil {
    private static final String TAG = "Machi";
    private static final String PREFS = "machi_reminders";
    private static final String KEY = "items";
    static final String CHANNEL = "machi_reminders";

    private ReminderUtil() {}

    private static synchronized JSONArray load(Context c) {
        try { return new JSONArray(c.getSharedPreferences(PREFS, Context.MODE_PRIVATE).getString(KEY, "[]")); }
        catch (Exception e) { return new JSONArray(); }
    }

    private static synchronized void save(Context c, JSONArray a) {
        c.getSharedPreferences(PREFS, Context.MODE_PRIVATE).edit().putString(KEY, a.toString()).apply();
    }

    private static int flags() {
        int f = PendingIntent.FLAG_UPDATE_CURRENT;
        if (Build.VERSION.SDK_INT >= 23) f |= PendingIntent.FLAG_IMMUTABLE;
        return f;
    }

    private static PendingIntent alarmIntent(Context c, String id, String title) {
        Intent i = new Intent(c, ReminderReceiver.class);
        i.setAction("ai.machi.assistant.REMINDER." + id);
        i.putExtra("id", id);
        i.putExtra("title", title);
        return PendingIntent.getBroadcast(c, id.hashCode(), i, flags());
    }

    private static PendingIntent openAppIntent(Context c, int requestCode) {
        Intent open = new Intent(c, MainActivity.class);
        open.setFlags(Intent.FLAG_ACTIVITY_NEW_TASK | Intent.FLAG_ACTIVITY_CLEAR_TOP);
        return PendingIntent.getActivity(c, requestCode, open, flags());
    }

    private static void setAlarm(Context c, String id, String title, long whenMs) {
        AlarmManager am = (AlarmManager) c.getSystemService(Context.ALARM_SERVICE);
        if (am == null) return;
        PendingIntent op = alarmIntent(c, id, title);
        try {
            am.setAlarmClock(new AlarmManager.AlarmClockInfo(whenMs, openAppIntent(c, 7)), op);
        } catch (Exception e) {
            Log.w(TAG, "setAlarmClock failed (" + e.getMessage() + "), using inexact alarm");
            try {
                if (Build.VERSION.SDK_INT >= 23) am.setAndAllowWhileIdle(AlarmManager.RTC_WAKEUP, whenMs, op);
                else am.set(AlarmManager.RTC_WAKEUP, whenMs, op);
            } catch (Exception e2) { Log.e(TAG, "alarm scheduling failed: " + e2.getMessage()); }
        }
    }

    /** @return "ok", "notifications_disabled" (alarm is set but the notification would be hidden) or "error" */
    public static String schedule(Context c, String id, String title, long whenMs) {
        try {
            JSONArray cur = load(c), next = new JSONArray();
            for (int i = 0; i < cur.length(); i++) {
                JSONObject o = cur.getJSONObject(i);
                if (!id.equals(o.optString("id"))) next.put(o);
            }
            JSONObject n = new JSONObject();
            n.put("id", id); n.put("title", title); n.put("when", whenMs);
            next.put(n);
            save(c, next);
            setAlarm(c, id, title, whenMs);
            Log.d(TAG, "reminder scheduled id=" + id + " in " + ((whenMs - System.currentTimeMillis()) / 1000) + "s");
            NotificationManager nm = (NotificationManager) c.getSystemService(Context.NOTIFICATION_SERVICE);
            if (nm != null && Build.VERSION.SDK_INT >= 24 && !nm.areNotificationsEnabled()) return "notifications_disabled";
            return "ok";
        } catch (Exception e) {
            Log.e(TAG, "schedule failed: " + e.getMessage());
            return "error";
        }
    }

    public static void cancel(Context c, String id) {
        try {
            JSONArray cur = load(c), next = new JSONArray();
            for (int i = 0; i < cur.length(); i++) {
                JSONObject o = cur.getJSONObject(i);
                if (!id.equals(o.optString("id"))) next.put(o);
            }
            save(c, next);
            AlarmManager am = (AlarmManager) c.getSystemService(Context.ALARM_SERVICE);
            if (am != null) am.cancel(alarmIntent(c, id, ""));
        } catch (Exception e) { Log.w(TAG, "cancel failed: " + e.getMessage()); }
    }

    /** Called after reboot / app update: alarms are lost then, so set them again from the stored list. */
    public static void rescheduleAll(Context c) {
        try {
            JSONArray cur = load(c), keep = new JSONArray();
            long now = System.currentTimeMillis();
            for (int i = 0; i < cur.length(); i++) {
                JSONObject o = cur.getJSONObject(i);
                long when = o.optLong("when");
                String id = o.optString("id"), title = o.optString("title");
                if (when > now) { setAlarm(c, id, title, when); keep.put(o); }
                else if (now - when < 24L * 3600 * 1000) { notifyNow(c, id, title + " (missed while the phone was off)"); }
            }
            save(c, keep);
        } catch (Exception e) { Log.w(TAG, "rescheduleAll failed: " + e.getMessage()); }
    }

    static void markFired(Context c, String id) {
        try {
            JSONArray cur = load(c), next = new JSONArray();
            for (int i = 0; i < cur.length(); i++) {
                JSONObject o = cur.getJSONObject(i);
                if (!id.equals(o.optString("id"))) next.put(o);
            }
            save(c, next);
        } catch (Exception ignored) {}
    }

    static void ensureChannel(Context c) {
        if (Build.VERSION.SDK_INT < 26) return;
        NotificationManager nm = (NotificationManager) c.getSystemService(Context.NOTIFICATION_SERVICE);
        if (nm == null || nm.getNotificationChannel(CHANNEL) != null) return;
        NotificationChannel ch = new NotificationChannel(CHANNEL, "Reminders", NotificationManager.IMPORTANCE_HIGH);
        ch.setDescription("Reminders you ask Machi to set");
        ch.enableVibration(true);
        ch.setLockscreenVisibility(Notification.VISIBILITY_PUBLIC);
        nm.createNotificationChannel(ch);
    }

    static void notifyNow(Context c, String id, String title) {
        try {
            ensureChannel(c);
            NotificationManager nm = (NotificationManager) c.getSystemService(Context.NOTIFICATION_SERVICE);
            if (nm == null) return;
            Notification.Builder b = Build.VERSION.SDK_INT >= 26 ? new Notification.Builder(c, CHANNEL) : new Notification.Builder(c);
            b.setSmallIcon(android.R.drawable.ic_popup_reminder)
             .setContentTitle("Machi reminder")
             .setContentText(title)
             .setStyle(new Notification.BigTextStyle().bigText(title))
             .setContentIntent(openAppIntent(c, id.hashCode()))
             .setAutoCancel(true)
             .setWhen(System.currentTimeMillis());
            if (Build.VERSION.SDK_INT >= 21) b.setCategory(Notification.CATEGORY_REMINDER).setVisibility(Notification.VISIBILITY_PUBLIC);
            if (Build.VERSION.SDK_INT < 26) {
                b.setPriority(Notification.PRIORITY_HIGH);
                b.setDefaults(Notification.DEFAULT_ALL);
            }
            nm.notify(id.hashCode(), b.build());
            Log.d(TAG, "reminder notification shown id=" + id);
        } catch (Exception e) { Log.e(TAG, "notifyNow failed: " + e.getMessage()); }
    }
}
