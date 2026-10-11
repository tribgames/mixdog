package io.mixdog.app;

import java.math.BigInteger;
import java.security.KeyFactory;
import java.security.PrivateKey;
import java.security.interfaces.ECPrivateKey;
import java.security.interfaces.ECPublicKey;
import java.security.spec.ECParameterSpec;
import java.security.spec.ECPoint;
import java.security.spec.ECPublicKeySpec;
import java.util.Arrays;
import javax.crypto.Cipher;
import javax.crypto.KeyAgreement;
import javax.crypto.Mac;
import javax.crypto.spec.GCMParameterSpec;
import javax.crypto.spec.SecretKeySpec;

/**
 * mixdog-native-push-v1, pure JDK (no Android classes) so it can be checked on
 * a plain JVM against apps/mobile/test-vectors/native-push-v1.json.
 *
 * key = HKDF-SHA256(ECDH(device private, epk), salt = empty,
 *                   info = "mixdog-native-push-v1", 32 bytes)
 * ct  = AES-256-GCM ciphertext || 16-byte tag
 */
final class NativePushCrypto {
  private static final byte[] INFO = "mixdog-native-push-v1".getBytes(java.nio.charset.StandardCharsets.UTF_8);
  private static final String ALPHABET = "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789-_";

  private NativePushCrypto() {}

  static byte[] decrypt(PrivateKey privateKey, byte[] epk, byte[] iv, byte[] ctWithTag) throws Exception {
    if (epk.length != 65 || epk[0] != 0x04) throw new IllegalArgumentException("bad epk");
    if (iv.length != 12) throw new IllegalArgumentException("bad iv");
    ECParameterSpec params = ((ECPrivateKey) privateKey).getParams();
    ECPoint point =
        new ECPoint(
            new BigInteger(1, Arrays.copyOfRange(epk, 1, 33)),
            new BigInteger(1, Arrays.copyOfRange(epk, 33, 65)));
    ECPublicKey peer =
        (ECPublicKey) KeyFactory.getInstance("EC").generatePublic(new ECPublicKeySpec(point, params));
    KeyAgreement agreement = KeyAgreement.getInstance("ECDH");
    agreement.init(privateKey);
    agreement.doPhase(peer, true);
    byte[] key = hkdfSha256(agreement.generateSecret(), INFO);
    Cipher cipher = Cipher.getInstance("AES/GCM/NoPadding");
    cipher.init(Cipher.DECRYPT_MODE, new SecretKeySpec(key, "AES"), new GCMParameterSpec(128, iv));
    return cipher.doFinal(ctWithTag);
  }

  /** HKDF (RFC 5869) with an empty salt, one 32-byte output block. */
  static byte[] hkdfSha256(byte[] secret, byte[] info) throws Exception {
    Mac mac = Mac.getInstance("HmacSHA256");
    mac.init(new SecretKeySpec(new byte[32], "HmacSHA256"));
    byte[] prk = mac.doFinal(secret);
    mac.init(new SecretKeySpec(prk, "HmacSHA256"));
    mac.update(info);
    mac.update((byte) 1);
    return mac.doFinal();
  }

  /** Uncompressed SEC1 point: 0x04 || X || Y, each 32 bytes. */
  static byte[] uncompressedPoint(ECPublicKey key) {
    byte[] out = new byte[65];
    out[0] = 0x04;
    System.arraycopy(fixed32(key.getW().getAffineX()), 0, out, 1, 32);
    System.arraycopy(fixed32(key.getW().getAffineY()), 0, out, 33, 32);
    return out;
  }

  private static byte[] fixed32(BigInteger value) {
    byte[] raw = value.toByteArray();
    byte[] out = new byte[32];
    int copy = Math.min(raw.length, 32);
    System.arraycopy(raw, raw.length - copy, out, 32 - copy, copy);
    return out;
  }

  static String base64UrlEncode(byte[] bytes) {
    StringBuilder out = new StringBuilder((bytes.length * 4 + 2) / 3);
    int index = 0;
    while (index + 2 < bytes.length) {
      int n = (bytes[index] & 0xff) << 16 | (bytes[index + 1] & 0xff) << 8 | (bytes[index + 2] & 0xff);
      out.append(ALPHABET.charAt(n >> 18 & 63)).append(ALPHABET.charAt(n >> 12 & 63));
      out.append(ALPHABET.charAt(n >> 6 & 63)).append(ALPHABET.charAt(n & 63));
      index += 3;
    }
    int rest = bytes.length - index;
    if (rest == 1) {
      int n = (bytes[index] & 0xff) << 16;
      out.append(ALPHABET.charAt(n >> 18 & 63)).append(ALPHABET.charAt(n >> 12 & 63));
    } else if (rest == 2) {
      int n = (bytes[index] & 0xff) << 16 | (bytes[index + 1] & 0xff) << 8;
      out.append(ALPHABET.charAt(n >> 18 & 63)).append(ALPHABET.charAt(n >> 12 & 63));
      out.append(ALPHABET.charAt(n >> 6 & 63));
    }
    return out.toString();
  }

  static byte[] base64UrlDecode(String text) {
    int length = text.length();
    byte[] out = new byte[length * 3 / 4];
    int outIndex = 0;
    int buffer = 0;
    int bits = 0;
    for (int i = 0; i < length; i++) {
      int value = ALPHABET.indexOf(text.charAt(i));
      if (value < 0) throw new IllegalArgumentException("bad base64url");
      buffer = buffer << 6 | value;
      bits += 6;
      if (bits >= 8) {
        bits -= 8;
        out[outIndex++] = (byte) (buffer >> bits & 0xff);
      }
    }
    return Arrays.copyOf(out, outIndex);
  }
}
