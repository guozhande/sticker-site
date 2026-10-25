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
  created_at INTEGER NOT NULL,              -- 毫秒时间戳
  ip_hash    TEXT,                          -- 上传者 IP 的哈希（不存明文；投诉追溯用）
  status     TEXT NOT NULL DEFAULT 'visible' -- visible / hidden（侵权投诉下架）
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
