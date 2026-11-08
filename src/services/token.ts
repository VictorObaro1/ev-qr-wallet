import crypto from 'crypto';
import QRCode from 'qrcode';

const TOKEN_PREFIX = 'RPP1';
const PASS_ID_BYTES = 16; // 128-bit random ID
const MAC_BYTES = 16; // 128-bit truncated HMAC-SHA256

export interface VerifiedToken {
  valid: boolean;
  passId?: string;
  reason?: 'MALFORMED_TOKEN' | 'UNSUPPORTED_VERSION' | 'INVALID_MAC';
}

export class TokenService {
  private readonly secret: Buffer;

  constructor(hmacSecret: string) {
    if (!hmacSecret || hmacSecret.length < 8) {
      throw new Error('PASS_HMAC_SECRET must be at least 8 characters long');
    }
    this.secret = Buffer.from(hmacSecret, 'utf-8');
  }

  /**
   * Generates a random 128-bit base64url pass_id.
   */
  public generatePassId(): string {
    return crypto.randomBytes(PASS_ID_BYTES).toString('base64url');
  }

  /**
   * Computes the 16-byte truncated HMAC-SHA256 in base64url for a given pass_id.
   */
  public computeMac(passId: string): string {
    const fullHmac = crypto
      .createHmac('sha256', this.secret)
      .update(passId, 'utf-8')
      .digest();
    return fullHmac.subarray(0, MAC_BYTES).toString('base64url');
  }

  /**
   * Formats the full QR payload: RPP1.<pass_id>.<mac>
   */
  public createToken(passId: string): string {
    const mac = this.computeMac(passId);
    return `${TOKEN_PREFIX}.${passId}.${mac}`;
  }

  /**
   * Verifies a QR token string using constant-time HMAC comparison.
   */
  public verifyToken(token: string): VerifiedToken {
    if (!token || typeof token !== 'string') {
      return { valid: false, reason: 'MALFORMED_TOKEN' };
    }

    const parts = token.trim().split('.');
    if (parts.length !== 3) {
      return { valid: false, reason: 'MALFORMED_TOKEN' };
    }

    const [prefix, passId, providedMacB64] = parts;
    if (prefix !== TOKEN_PREFIX) {
      return { valid: false, reason: 'UNSUPPORTED_VERSION' };
    }

    if (!passId || !providedMacB64) {
      return { valid: false, reason: 'MALFORMED_TOKEN' };
    }

    let providedMacBuf: Buffer;
    try {
      providedMacBuf = Buffer.from(providedMacB64, 'base64url');
    } catch {
      return { valid: false, reason: 'MALFORMED_TOKEN' };
    }

    if (providedMacBuf.length !== MAC_BYTES) {
      return { valid: false, reason: 'INVALID_MAC' };
    }

    const expectedMacB64 = this.computeMac(passId);
    const expectedMacBuf = Buffer.from(expectedMacB64, 'base64url');

    if (providedMacBuf.length !== expectedMacBuf.length) {
      return { valid: false, reason: 'INVALID_MAC' };
    }

    const isMatch = crypto.timingSafeEqual(providedMacBuf, expectedMacBuf);
    if (!isMatch) {
      return { valid: false, reason: 'INVALID_MAC' };
    }

    return { valid: true, passId };
  }

  /**
   * Renders a scannable PNG buffer for a given QR payload string.
   */
  public async generateQrPngBuffer(qrPayload: string): Promise<Buffer> {
    return QRCode.toBuffer(qrPayload, {
      type: 'png',
      errorCorrectionLevel: 'M',
      margin: 2,
      width: 320,
    });
  }
}
