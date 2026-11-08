import crypto from 'crypto';
import { StructuredToolError } from '../errors.js';

export interface CreateTransferChargeInput {
  orderId: string;
  riderId: string;
  amountKobo: number;
  expiresAt: Date;
}

export interface CreateTransferChargeResult {
  paystackRef: string;
  bankName: string;
  accountNumber: string;
}

export interface VerifyTransactionResult {
  status: 'success' | 'pending' | 'abandoned' | 'failed';
  amountKobo: number;
  reference: string;
}

const PLACEHOLDER_KEYS = new Set([
  'sk_test_mock_secret_key',
  'sk_test_replace_with_your_paystack_test_secret_key',
  '',
]);

export class PaystackService {
  private readonly secretKey: string;
  private readonly baseUrl: string;
  private readonly fetchFn: typeof fetch;

  constructor(
    secretKey: string,
    baseUrl = 'https://api.paystack.co',
    fetchFn: typeof fetch = globalThis.fetch
  ) {
    this.secretKey = secretKey;
    this.baseUrl = baseUrl.replace(/\/+$/, '');
    this.fetchFn = fetchFn;
  }

  public isLiveTestKeyConfigured(): boolean {
    return !PLACEHOLDER_KEYS.has(this.secretKey.trim());
  }

  /**
   * Generates a deterministic 10-digit NUBAN-style test account number for an order
   * when Paystack test mode does not return a dedicated virtual account number.
   */
  private generateTestAccountNumber(orderId: string): string {
    const hash = crypto.createHash('sha256').update(orderId).digest();
    const digits = (hash.readUInt32BE(0) % 900000000) + 100000000;
    return `0${digits}`; // 10 digits starting with 0
  }

  /**
   * Creates a Paystack test bank-transfer charge.
   * Calls POST /charge (Pay with Transfer) first; if the merchant test account
   * does not have Pay with Transfer enabled (400), falls back to POST /transaction/initialize
   * so a real transaction reference is always created on the Paystack Test Dashboard.
   */
  public async createBankTransferCharge(
    input: CreateTransferChargeInput
  ): Promise<CreateTransferChargeResult> {
    const reference = `rp_${input.orderId.toLowerCase().replace(/[^a-z0-9_]/g, '_')}`;
    const fallbackAccount = this.generateTestAccountNumber(input.orderId);

    if (!this.isLiveTestKeyConfigured()) {
      return {
        paystackRef: reference,
        bankName: 'Paystack-Titan',
        accountNumber: fallbackAccount,
      };
    }

    const email = `${input.riderId.toLowerCase().replace(/[^a-z0-9]/g, '')}@riders.ridepay.ng`;
    const headers = {
      Authorization: `Bearer ${this.secretKey}`,
      'Content-Type': 'application/json',
    };

    try {
      // 1. Attempt POST /charge with bank_transfer
      const chargeRes = await this.fetchFn(`${this.baseUrl}/charge`, {
        method: 'POST',
        headers,
        body: JSON.stringify({
          email,
          amount: String(input.amountKobo),
          reference,
          bank_transfer: {
            account_expires_at: input.expiresAt.toISOString(),
          },
          metadata: {
            order_id: input.orderId,
            rider_id: input.riderId,
          },
        }),
      });

      if (chargeRes.status >= 500) {
        throw new StructuredToolError(
          'PAYSTACK_UNAVAILABLE',
          `Paystack returned HTTP ${chargeRes.status} while creating transfer charge.`,
          true
        );
      }

      if (chargeRes.ok) {
        const body = (await chargeRes.json()) as any;
        if (body?.status && body?.data) {
          const data = body.data;
          return {
            paystackRef: data.reference || reference,
            bankName: data.bank?.name || data.bank_name || 'Paystack-Titan',
            accountNumber: data.account_number || fallbackAccount,
          };
        }
      }

      // 2. Fallback to POST /transaction/initialize (works on all Paystack test keys)
      const initRes = await this.fetchFn(`${this.baseUrl}/transaction/initialize`, {
        method: 'POST',
        headers,
        body: JSON.stringify({
          email,
          amount: String(input.amountKobo),
          reference,
          channels: ['bank_transfer'],
          metadata: {
            order_id: input.orderId,
            rider_id: input.riderId,
          },
        }),
      });

      if (initRes.status >= 500) {
        throw new StructuredToolError(
          'PAYSTACK_UNAVAILABLE',
          `Paystack returned HTTP ${initRes.status} while initializing transaction.`,
          true
        );
      }

      if (!initRes.ok) {
        const errText = await initRes.text().catch(() => '');
        throw new StructuredToolError(
          'PAYSTACK_UNAVAILABLE',
          `Unable to initialize Paystack transaction (HTTP ${initRes.status}): ${errText.slice(0, 120)}`,
          true
        );
      }

      const initBody = (await initRes.json()) as any;
      return {
        paystackRef: initBody?.data?.reference || reference,
        bankName: 'Paystack-Titan',
        accountNumber: fallbackAccount,
      };
    } catch (err) {
      if (err instanceof StructuredToolError) {
        throw err;
      }
      throw new StructuredToolError(
        'PAYSTACK_UNAVAILABLE',
        'Could not reach Paystack payment service. Please retry in a moment.',
        true
      );
    }
  }

  /**
   * Re-checks a transaction's status directly against Paystack's Verify API.
   * Returns null if running with an offline placeholder key or if verification fails transiently.
   */
  public async verifyTransaction(reference: string): Promise<VerifyTransactionResult | null> {
    if (!this.isLiveTestKeyConfigured()) {
      return null;
    }

    try {
      const res = await this.fetchFn(
        `${this.baseUrl}/transaction/verify/${encodeURIComponent(reference)}`,
        {
          method: 'GET',
          headers: {
            Authorization: `Bearer ${this.secretKey}`,
          },
        }
      );

      if (!res.ok) {
        return null;
      }

      const body = (await res.json()) as any;
      if (!body?.status || !body?.data) {
        return null;
      }

      const rawStatus = String(body.data.status || 'pending').toLowerCase();
      const status: VerifyTransactionResult['status'] =
        rawStatus === 'success'
          ? 'success'
          : rawStatus === 'abandoned'
          ? 'abandoned'
          : rawStatus === 'failed'
          ? 'failed'
          : 'pending';

      return {
        status,
        amountKobo: Number(body.data.amount || 0),
        reference: String(body.data.reference || reference),
      };
    } catch {
      return null;
    }
  }

  /**
   * Computes HMAC-SHA512 hex signature for a raw webhook payload.
   */
  public computeWebhookSignature(rawBody: string | Buffer): string {
    return crypto
      .createHmac('sha512', this.secretKey)
      .update(rawBody)
      .digest('hex');
  }

  /**
   * Verifies x-paystack-signature header in constant time.
   */
  public verifyWebhookSignature(rawBody: string | Buffer, signatureHeader?: string): boolean {
    if (!signatureHeader || typeof signatureHeader !== 'string') {
      return false;
    }
    const expectedHex = this.computeWebhookSignature(rawBody);
    const providedBuf = Buffer.from(signatureHeader.trim(), 'utf-8');
    const expectedBuf = Buffer.from(expectedHex, 'utf-8');
    if (providedBuf.length !== expectedBuf.length) {
      return false;
    }
    return crypto.timingSafeEqual(providedBuf, expectedBuf);
  }
}
