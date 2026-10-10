package io.mixdog.app;

import android.content.Context;
import android.content.SharedPreferences;
import android.security.keystore.KeyGenParameterSpec;
import android.security.keystore.KeyProperties;
import android.util.Base64;
import java.security.KeyFactory;
import java.security.KeyPair;
import java.security.KeyPairGenerator;
import java.security.KeyStore;
import java.security.PrivateKey;
import java.security.interfaces.ECPublicKey;
import java.security.spec.ECGenParameterSpec;
import java.security.spec.PKCS8EncodedKeySpec;
import javax.crypto.Cipher;
import javax.crypto.KeyGenerator;
import javax.crypto.SecretKey;
import javax.crypto.spec.GCMParameterSpec;

/**
 * The per-install P-256 key pair for native push. The private key is stored
 * only as PKCS#8 wrapped (AES-256-GCM) by a non-exportable Android Keystore
 * key; Keystore EC keys cannot do ECDH below API 31, so wrapping keeps one
 * code path for every supported API level.
 */
final class MixdogKeys {
  private static final String WRAP_ALIAS = "mixdog_push_wrap_v1";
  private static final String PREFS = "mixdog_native_push_keys";
  private static final String WRAPPED = "wrapped_private";
  private static final String PUBLIC = "public_key";

  private MixdogKeys() {}

  private static SharedPreferences prefs(Context context) {
    return context.getApplicationContext().getSharedPreferences(PREFS, Context.MODE_PRIVATE);
  }

  private static SecretKey wrapKey() throws Exception {
    KeyStore store = KeyStore.getInstance("AndroidKeyStore");
    store.load(null);
    if (store.containsAlias(WRAP_ALIAS)) return (SecretKey) store.getKey(WRAP_ALIAS, null);
    KeyGenerator generator = KeyGenerator.getInstance(KeyProperties.KEY_ALGORITHM_AES, "AndroidKeyStore");
    generator.init(
        new KeyGenParameterSpec.Builder(
                WRAP_ALIAS, KeyProperties.PURPOSE_ENCRYPT | KeyProperties.PURPOSE_DECRYPT)
            .setBlockModes(KeyProperties.BLOCK_MODE_GCM)
            .setEncryptionPaddings(KeyProperties.ENCRYPTION_PADDING_NONE)
            .setKeySize(256)
            .build());
    return generator.generateKey();
  }

  private static synchronized void ensure(Context context) throws Exception {
    SharedPreferences prefs = prefs(context);
    if (prefs.contains(WRAPPED) && prefs.contains(PUBLIC)) return;
    KeyPairGenerator generator = KeyPairGenerator.getInstance("EC");
    generator.initialize(new ECGenParameterSpec("secp256r1"));
    KeyPair pair = generator.generateKeyPair();
    Cipher cipher = Cipher.getInstance("AES/GCM/NoPadding");
    cipher.init(Cipher.ENCRYPT_MODE, wrapKey());
    byte[] sealed = cipher.doFinal(pair.getPrivate().getEncoded());
    byte[] iv = cipher.getIV();
    byte[] blob = new byte[iv.length + sealed.length];
    System.arraycopy(iv, 0, blob, 0, iv.length);
    System.arraycopy(sealed, 0, blob, iv.length, sealed.length);
    prefs
        .edit()
        .putString(WRAPPED, Base64.encodeToString(blob, Base64.NO_WRAP))
        .putString(
            PUBLIC, NativePushCrypto.base64UrlEncode(NativePushCrypto.uncompressedPoint((ECPublicKey) pair.getPublic())))
        .apply();
  }

  /** Uncompressed public key, base64url ('' if the keystore is unusable). */
  static String publicKey(Context context) {
    try {
      ensure(context);
      return prefs(context).getString(PUBLIC, "");
    } catch (Exception e) {
      return "";
    }
  }

  static PrivateKey privateKey(Context context) throws Exception {
    ensure(context);
    byte[] blob = Base64.decode(prefs(context).getString(WRAPPED, ""), Base64.NO_WRAP);
    Cipher cipher = Cipher.getInstance("AES/GCM/NoPadding");
    cipher.init(Cipher.DECRYPT_MODE, wrapKey(), new GCMParameterSpec(128, blob, 0, 12));
    byte[] pkcs8 = cipher.doFinal(blob, 12, blob.length - 12);
    return KeyFactory.getInstance("EC").generatePrivate(new PKCS8EncodedKeySpec(pkcs8));
  }
}
