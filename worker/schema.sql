-- 表情包站数据库结构（D1）
--
-- 应用方式：wrangler.toml 无 migrations 自动机制、代码也不引用本文件，
-- 新库建库/重建时手工执行：wrangler d1 execute <DB_NAME> --file=worker/schema.sql
-- （全部 CREATE IF NOT EXISTS，幂等，可重复跑）。
-- 已部署的存量库升级积分体系时，必须额外手工执行一次（SQLite 无 IF NOT EXISTS ADD COLUMN）：
--   ALTER TABLE uploads ADD COLUMN user_id TEXT;
-- 漏做该 ALTER 则 handleUpload 插入 user_id 时直接 SQL 报错。

-- 用户上传的表情包元数据
-- 图片字节存 R2，这里只存索引信息
CREATE TABLE IF NOT EXISTS uploads (
  id         TEXT PRIMARY KEY,              -- UUID
  r2_key     TEXT NOT NULL,                 -- R2 对象键
  filename   TEXT NOT NULL,                 -- 原始文件名
  mime       TEXT NOT NULL,                 -- image/gif | image/jpeg | image/png ...
  size       INTEGER NOT NULL,              -- 字节数
  work       TEXT NOT NULL,                 -- 作品名（用户输入，对应网站的二级/三级标签）
  characters TEXT NOT NULL DEFAULT '[]',    -- 角色名，JSON 数组；非单角色时多个
  search_keys TEXT DEFAULT NULL,            -- 预生成搜索键（JSON），NULL=旧行走客户端回退
  created_at INTEGER NOT NULL,              -- 毫秒时间戳
  ip_hash    TEXT,                          -- 上传者 IP 的哈希（不存明文；投诉追溯用）
  user_id    TEXT,                          -- 上传者游客账户 id（关联 users.id；存量行为 NULL，审核通过时无人可发分）
  status     TEXT NOT NULL DEFAULT 'visible' -- pending（待审核，不展示不发分）/ visible（审核通过）/ hidden（投诉下架）
);

CREATE INDEX IF NOT EXISTS idx_uploads_created ON uploads(created_at DESC);
CREATE INDEX IF NOT EXISTS idx_uploads_status  ON uploads(status, created_at DESC);
CREATE INDEX IF NOT EXISTS idx_uploads_work    ON uploads(work);

-- AI 生成（豆包 Seedream 文生图）的请求计数：只用于 per-IP 限流，不存图片元数据。
-- 图片字节照旧存 R2（键形如 ai/<yyyymm>/<uuid>.jpg），真正「上传到站」时再进 uploads 表。
CREATE TABLE IF NOT EXISTS ai_requests (
  id         TEXT PRIMARY KEY,              -- UUID
  ip_hash    TEXT NOT NULL,                 -- 请求者 IP 哈希（不存明文）
  created_at INTEGER NOT NULL               -- 毫秒时间戳
);

CREATE INDEX IF NOT EXISTS idx_ai_requests_ip_created ON ai_requests(ip_hash, created_at DESC);

-- ============ 积分体系（D1 三表）============

-- 用户账户。本期全部为游客：id = X-Device-Id（客户端生成 UUID），无头时 = sha256(ip|sticker-salt)。
-- 签到连续天数不设列，从 points_log 最近 21 行签到流水推算（保持冻结列清单）。
CREATE TABLE IF NOT EXISTS users (
  id             TEXT PRIMARY KEY,               -- 游客账户 id = X-Device-Id（客户端生成 UUID）；无头时 = sha256(ip|sticker-salt)
  login_type     TEXT NOT NULL DEFAULT 'guest',  -- phone / wechat / qq / guest（本期全部 guest）
  openid         TEXT,                           -- 第三方登录 openid（本期 NULL）
  nickname       TEXT,                           -- 昵称（本期可空）
  points         INTEGER NOT NULL DEFAULT 0,     -- 当前积分余额（1 积分 = 1 分钱）
  total_earned   INTEGER NOT NULL DEFAULT 0,     -- 累计获得（只增不减，展示用；AI 扣分不动它）
  created_at     INTEGER NOT NULL,               -- 毫秒时间戳
  last_signin_at INTEGER                         -- 上次签到毫秒时间戳（NULL=从未签到）
);

CREATE INDEX IF NOT EXISTS idx_users_login ON users(login_type, openid);

-- 积分流水。status 列是冻结设计「悬挂保护 pending 行」的硬要求。
-- 退回不改 change 值（change 保持负），靠 status 流转表达退款；余额补回写 users。
-- idx_points_log_pending 供惰性清理过期 pending 扫描。
CREATE TABLE IF NOT EXISTS points_log (
  id            TEXT PRIMARY KEY,                -- 通常 UUID；签到行用确定性 id 'signin:{user_id}:{dayKey}'，靠主键冲突原子防同日重复签到
  user_id       TEXT NOT NULL,                   -- 关联 users.id
  change        INTEGER NOT NULL,                -- 变动值：正=获得 / 负=扣减
  reason        TEXT NOT NULL,                   -- signin / upload / recharge / ai_spend
  status        TEXT NOT NULL DEFAULT 'confirmed', -- confirmed / pending（AI 预扣未结算）/ refunded（已退回）
  balance_after INTEGER NOT NULL,                -- 本笔变动后的余额快照
  created_at    INTEGER NOT NULL                 -- 毫秒时间戳
);

CREATE INDEX IF NOT EXISTS idx_points_log_user_created ON points_log(user_id, created_at DESC);
CREATE INDEX IF NOT EXISTS idx_points_log_pending    ON points_log(status, created_at);

-- 充值订单。本期模拟支付：直接落 paid（真支付上线前任何人可无限刷分，属已知风险）。
-- API 入参 amount 单位「元」（1–1000 元整数，1 元 = 100 积分），入库前折算为分存储；
-- amount 列单位「分」（= 发放积分数，points = amount），恒为 100 的整数倍（按元充值）。
CREATE TABLE IF NOT EXISTS recharge_orders (
  id         TEXT PRIMARY KEY,                   -- UUID
  user_id    TEXT NOT NULL,                      -- 关联 users.id
  amount     INTEGER NOT NULL,                   -- 支付金额，单位「分」，须为 100 的整数倍（按元充值）
  points     INTEGER NOT NULL,                   -- 发放积分（1 元 = 100 积分 → points = amount）
  status     TEXT NOT NULL DEFAULT 'pending',    -- pending / paid（本期模拟支付：直接落 paid）
  created_at INTEGER NOT NULL                    -- 毫秒时间戳
);

CREATE INDEX IF NOT EXISTS idx_recharge_orders_user_created ON recharge_orders(user_id, created_at DESC);
