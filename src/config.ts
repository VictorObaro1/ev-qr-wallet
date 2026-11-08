import dotenv from 'dotenv';

dotenv.config();

export interface AppConfig {
  port: number;
  publicBaseUrl: string;
  databaseUrl: string;
  mcpBearerToken: string;
  stationBearerToken: string;
  passHmacSecret: string;
  paystackSecretKey: string;
  paystackBaseUrl: string;
  swapPriceNgn: number;
  minPassQuantity: number;
  maxPassQuantity: number;
  orderExpiryMinutes: number;
  passValidityDays: number;
  verifyRiderMaxFailedPerMin: number;
  verifyRiderMaxTotalPerMin: number;
}

export function loadConfig(): AppConfig {
  const port = parseInt(process.env.PORT || '3000', 10);
  return {
    port,
    publicBaseUrl: (process.env.PUBLIC_BASE_URL || `http://localhost:${port}`).replace(/\/+$/, ''),
    databaseUrl: process.env.DATABASE_URL || '',
    mcpBearerToken: process.env.MCP_BEARER_TOKEN || 'mcp_secret_token_change_me',
    stationBearerToken: process.env.STATION_BEARER_TOKEN || 'station_secret_token_change_me',
    passHmacSecret: process.env.PASS_HMAC_SECRET || 'ridepay_pass_hmac_secret_change_me_32bytes',
    paystackSecretKey: process.env.PAYSTACK_SECRET_KEY || 'sk_test_mock_secret_key',
    paystackBaseUrl: (process.env.PAYSTACK_BASE_URL || 'https://api.paystack.co').replace(/\/+$/, ''),
    swapPriceNgn: parseInt(process.env.SWAP_PRICE_NGN || '750', 10),
    minPassQuantity: parseInt(process.env.MIN_PASS_QUANTITY || '2', 10),
    maxPassQuantity: parseInt(process.env.MAX_PASS_QUANTITY || '10', 10),
    orderExpiryMinutes: parseInt(process.env.ORDER_EXPIRY_MINUTES || '30', 10),
    passValidityDays: parseInt(process.env.PASS_VALIDITY_DAYS || '30', 10),
    verifyRiderMaxFailedPerMin: parseInt(process.env.VERIFY_RIDER_MAX_FAILED_PER_MIN || '5', 10),
    verifyRiderMaxTotalPerMin: parseInt(process.env.VERIFY_RIDER_MAX_TOTAL_PER_MIN || '15', 10),
  };
}
