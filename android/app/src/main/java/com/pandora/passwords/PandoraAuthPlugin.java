package com.pandora.passwords;

import android.content.SharedPreferences;
import android.security.keystore.KeyGenParameterSpec;
import android.security.keystore.KeyProperties;
import android.util.Base64;
import androidx.biometric.BiometricManager;
import androidx.biometric.BiometricPrompt;
import androidx.fragment.app.FragmentActivity;
import androidx.core.content.ContextCompat;
import com.getcapacitor.JSObject;
import com.getcapacitor.Plugin;
import com.getcapacitor.PluginCall;
import com.getcapacitor.PluginMethod;
import com.getcapacitor.annotation.CapacitorPlugin;
import java.nio.charset.StandardCharsets;
import java.security.KeyStore;
import java.security.MessageDigest;
import java.security.SecureRandom;
import javax.crypto.Cipher;
import javax.crypto.KeyGenerator;
import javax.crypto.SecretKey;
import javax.crypto.SecretKeyFactory;
import javax.crypto.spec.GCMParameterSpec;
import javax.crypto.spec.PBEKeySpec;

@CapacitorPlugin(name = "PandoraAuth")
public class PandoraAuthPlugin extends Plugin {
  private static final String STORE = "pandora_device_auth";
  private static final String KEY_ALIAS = "pandora_master_password_v1";
  private static final int PIN_ITERATIONS = 310000;

  private SharedPreferences preferences() {
    return getContext().getSharedPreferences(STORE, 0);
  }

  private static boolean validPin(String pin) {
    return pin != null && pin.matches("\\d{4,}");
  }

  private static String encode(byte[] value) {
    return Base64.encodeToString(value, Base64.NO_WRAP);
  }

  private static byte[] decode(String value) {
    return Base64.decode(value, Base64.NO_WRAP);
  }

  private static byte[] pinHash(String pin, byte[] salt) throws Exception {
    PBEKeySpec spec = new PBEKeySpec(pin.toCharArray(), salt, PIN_ITERATIONS, 256);
    try {
      return SecretKeyFactory.getInstance("PBKDF2WithHmacSHA256").generateSecret(spec).getEncoded();
    } finally {
      spec.clearPassword();
    }
  }

  private SecretKey secretKey() throws Exception {
    KeyStore store = KeyStore.getInstance("AndroidKeyStore");
    store.load(null);
    SecretKey existing = (SecretKey) store.getKey(KEY_ALIAS, null);
    if (existing != null) return existing;

    KeyGenerator generator = KeyGenerator.getInstance(KeyProperties.KEY_ALGORITHM_AES, "AndroidKeyStore");
    generator.init(
      new KeyGenParameterSpec.Builder(KEY_ALIAS, KeyProperties.PURPOSE_ENCRYPT | KeyProperties.PURPOSE_DECRYPT)
        .setBlockModes(KeyProperties.BLOCK_MODE_GCM)
        .setEncryptionPaddings(KeyProperties.ENCRYPTION_PADDING_NONE)
        .setKeySize(256)
        .build()
    );
    return generator.generateKey();
  }

  private void storeMasterPassword(String masterPassword) throws Exception {
    Cipher cipher = Cipher.getInstance("AES/GCM/NoPadding");
    cipher.init(Cipher.ENCRYPT_MODE, secretKey());
    byte[] ciphertext = cipher.doFinal(masterPassword.getBytes(StandardCharsets.UTF_8));
    preferences().edit().putString("master", encode(ciphertext)).putString("iv", encode(cipher.getIV())).apply();
  }

  private String readMasterPasswordValue() throws Exception {
    String ciphertext = preferences().getString("master", null);
    String iv = preferences().getString("iv", null);
    if (ciphertext == null || iv == null) throw new IllegalStateException("Локальная авторизация не настроена.");
    Cipher cipher = Cipher.getInstance("AES/GCM/NoPadding");
    cipher.init(Cipher.DECRYPT_MODE, secretKey(), new GCMParameterSpec(128, decode(iv)));
    return new String(cipher.doFinal(decode(ciphertext)), StandardCharsets.UTF_8);
  }

  private void storePin(String pin) throws Exception {
    byte[] salt = new byte[16];
    new SecureRandom().nextBytes(salt);
    preferences().edit().putString("pinSalt", encode(salt)).putString("pinHash", encode(pinHash(pin, salt))).putInt("failed", 0).apply();
  }

  private boolean pinMatches(String pin) throws Exception {
    String salt = preferences().getString("pinSalt", null);
    String expected = preferences().getString("pinHash", null);
    return validPin(pin) && salt != null && expected != null && MessageDigest.isEqual(pinHash(pin, decode(salt)), decode(expected));
  }

  @PluginMethod
  public void status(PluginCall call) {
    SharedPreferences prefs = preferences();
    JSObject result = new JSObject();
    result.put("configured", prefs.contains("master") && prefs.contains("pinHash"));
    result.put("failedAttempts", prefs.getInt("failed", 0));
    call.resolve(result);
  }

  @PluginMethod
  public void setup(PluginCall call) {
    String masterPassword = call.getString("masterPassword", "");
    String pin = call.getString("pin", "");
    if (masterPassword.length() < 8 || !validPin(pin)) {
      call.reject("Мастер-пароль и PIN не соответствуют требованиям.");
      return;
    }
    try {
      storeMasterPassword(masterPassword);
      storePin(pin);
      call.resolve();
    } catch (Exception error) {
      call.reject("Не удалось сохранить данные входа в Android Keystore.", error);
    }
  }

  @PluginMethod
  public void unlockWithPin(PluginCall call) {
    String pin = call.getString("pin", "");
    try {
      int previousFailures = preferences().getInt("failed", 0);
      if (previousFailures >= 3) {
        JSObject result = new JSObject();
        result.put("failedAttempts", 3);
        result.put("remainingAttempts", 0);
        result.put("requiresMasterPassword", true);
        call.resolve(result);
        return;
      }
      if (!pinMatches(pin)) {
        int failed = Math.min(previousFailures + 1, 3);
        preferences().edit().putInt("failed", failed).apply();
        JSObject result = new JSObject();
        result.put("failedAttempts", failed);
        result.put("remainingAttempts", Math.max(0, 3 - failed));
        result.put("requiresMasterPassword", failed >= 3);
        call.resolve(result);
        return;
      }
      preferences().edit().putInt("failed", 0).apply();
      JSObject result = new JSObject();
      result.put("masterPassword", readMasterPasswordValue());
      result.put("failedAttempts", 0);
      result.put("remainingAttempts", 3);
      result.put("requiresMasterPassword", false);
      call.resolve(result);
    } catch (Exception error) {
      call.reject("Не удалось открыть защищённые данные.", error);
    }
  }

  @PluginMethod
  public void unlockWithBiometric(PluginCall call) {
    getActivity().runOnUiThread(() -> {
      FragmentActivity activity = (FragmentActivity) getActivity();
      BiometricPrompt prompt = new BiometricPrompt(
        activity,
        ContextCompat.getMainExecutor(getContext()),
        new BiometricPrompt.AuthenticationCallback() {
          @Override
          public void onAuthenticationSucceeded(BiometricPrompt.AuthenticationResult authenticationResult) {
            super.onAuthenticationSucceeded(authenticationResult);
            try {
              preferences().edit().putInt("failed", 0).apply();
              JSObject result = new JSObject();
              result.put("masterPassword", readMasterPasswordValue());
              call.resolve(result);
            } catch (Exception error) {
              call.reject("Не удалось открыть защищённые данные.", error);
            }
          }

          @Override
          public void onAuthenticationError(int errorCode, CharSequence errorMessage) {
            super.onAuthenticationError(errorCode, errorMessage);
            call.reject(errorMessage == null ? "Биометрическая проверка отменена." : errorMessage.toString());
          }
        }
      );
      BiometricPrompt.PromptInfo promptInfo = new BiometricPrompt.PromptInfo.Builder()
        .setTitle("Pandora")
        .setSubtitle("Подтвердите вход по отпечатку пальца")
        .setAllowedAuthenticators(BiometricManager.Authenticators.BIOMETRIC_STRONG)
        .setNegativeButtonText("Отмена")
        .build();
      prompt.authenticate(promptInfo);
    });
  }

  @PluginMethod
  public void updatePin(PluginCall call) {
    String masterPassword = call.getString("masterPassword", "");
    String pin = call.getString("pin", "");
    try {
      if (!MessageDigest.isEqual(masterPassword.getBytes(StandardCharsets.UTF_8), readMasterPasswordValue().getBytes(StandardCharsets.UTF_8))) {
        call.reject("Неверный мастер-пароль.");
        return;
      }
      if (!validPin(pin)) {
        call.reject("PIN должен содержать минимум 4 цифры.");
        return;
      }
      storePin(pin);
      call.resolve();
    } catch (Exception error) {
      call.reject("Не удалось изменить PIN.", error);
    }
  }

  @PluginMethod
  public void updateMasterPassword(PluginCall call) {
    String masterPassword = call.getString("masterPassword", "");
    if (masterPassword.length() < 8) {
      call.reject("Мастер-пароль должен содержать минимум 8 символов.");
      return;
    }
    try {
      storeMasterPassword(masterPassword);
      preferences().edit().putInt("failed", 0).apply();
      call.resolve();
    } catch (Exception error) {
      call.reject("Не удалось изменить мастер-пароль.", error);
    }
  }

  @PluginMethod
  public void resetFailures(PluginCall call) {
    preferences().edit().putInt("failed", 0).apply();
    call.resolve();
  }

  @PluginMethod
  public void clear(PluginCall call) {
    preferences().edit().clear().apply();
    try {
      KeyStore store = KeyStore.getInstance("AndroidKeyStore");
      store.load(null);
      store.deleteEntry(KEY_ALIAS);
    } catch (Exception ignored) {
      // Preferences are already cleared, so reset is complete for the app.
    }
    call.resolve();
  }
}
