CREATE TABLE IF NOT EXISTS riders (
  rider_id       TEXT PRIMARY KEY,
  display_name   TEXT NOT NULL,
  chat_sender_id TEXT UNIQUE,
  status         TEXT NOT NULL DEFAULT 'ACTIVE'
);

CREATE TABLE IF NOT EXISTS swap_orders (
  order_id         TEXT PRIMARY KEY,
  rider_id         TEXT NOT NULL REFERENCES riders(rider_id),
  quantity         INT  NOT NULL CHECK (quantity >= 2 AND quantity <= 10),
  amount_kobo      BIGINT NOT NULL,
  amount_paid_kobo BIGINT NOT NULL DEFAULT 0,
  bank_name        TEXT NOT NULL,
  account_number   TEXT NOT NULL,
  idempotency_key  TEXT NOT NULL UNIQUE,
  paystack_ref     TEXT UNIQUE,
  status           TEXT NOT NULL,
  expires_at       TIMESTAMPTZ NOT NULL,
  created_at       TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS passes (
  pass_id     TEXT PRIMARY KEY,
  order_id    TEXT NOT NULL UNIQUE REFERENCES swap_orders(order_id),
  rider_id    TEXT NOT NULL REFERENCES riders(rider_id),
  total_uses  INT  NOT NULL CHECK (total_uses >= 2),
  remaining   INT  NOT NULL CHECK (remaining >= 0),
  status      TEXT NOT NULL DEFAULT 'ACTIVE',
  expires_at  TIMESTAMPTZ NOT NULL,
  created_at  TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS redemptions (
  scan_id         TEXT PRIMARY KEY,
  pass_id         TEXT REFERENCES passes(pass_id),
  station_id      TEXT NOT NULL,
  result          TEXT NOT NULL,
  remaining_after INT,
  created_at      TIMESTAMPTZ NOT NULL DEFAULT now()
);
