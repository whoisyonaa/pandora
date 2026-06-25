package com.pandora.passwords;

import com.getcapacitor.JSArray;
import com.getcapacitor.JSObject;
import com.getcapacitor.Plugin;
import com.getcapacitor.PluginCall;
import com.getcapacitor.PluginMethod;
import com.getcapacitor.annotation.CapacitorPlugin;
import java.net.DatagramPacket;
import java.net.DatagramSocket;
import java.nio.charset.StandardCharsets;
import java.util.HashSet;
import java.util.Set;
import org.json.JSONArray;
import org.json.JSONObject;

@CapacitorPlugin(name = "PandoraDiscovery")
public class PandoraDiscoveryPlugin extends Plugin {
  private static final int DISCOVERY_PORT = 45454;

  @PluginMethod
  public void scan(PluginCall call) {
    int timeoutMs = call.getInt("timeoutMs", 3500);

    getBridge()
      .execute(
        () -> {
          JSArray hosts = new JSArray();
          Set<String> seen = new HashSet<>();

          try (DatagramSocket socket = new DatagramSocket(DISCOVERY_PORT)) {
            socket.setBroadcast(true);
            socket.setSoTimeout(Math.min(Math.max(timeoutMs, 1000), 8000));
            long endAt = System.currentTimeMillis() + timeoutMs;

            while (System.currentTimeMillis() < endAt) {
              try {
                byte[] buffer = new byte[8192];
                DatagramPacket packet = new DatagramPacket(buffer, buffer.length);
                socket.receive(packet);
                String raw = new String(packet.getData(), 0, packet.getLength(), StandardCharsets.UTF_8);
                JSONObject beacon = new JSONObject(raw);
                if (!"pandora-sync-host".equals(beacon.optString("type"))) continue;

                JSONArray urls = beacon.optJSONArray("urls");
                if (urls == null || urls.length() == 0) continue;
                String key = beacon.optString("code") + urls.toString();
                if (!seen.add(key)) continue;

                JSObject host = new JSObject();
                host.put("name", beacon.optString("name", "Pandora PC"));
                host.put("code", beacon.optString("code"));
                JSArray hostUrls = new JSArray();
                for (int index = 0; index < urls.length(); index++) {
                  hostUrls.put(urls.optString(index));
                }
                host.put("urls", hostUrls);
                hosts.put(host);
              } catch (Exception ignored) {
                // Keep listening until timeout; malformed packets are not ours.
              }
            }

            JSObject result = new JSObject();
            result.put("hosts", hosts);
            call.resolve(result);
          } catch (Exception error) {
            call.reject(error.getMessage() != null ? error.getMessage() : "Discovery failed");
          }
        }
      );
  }
}
