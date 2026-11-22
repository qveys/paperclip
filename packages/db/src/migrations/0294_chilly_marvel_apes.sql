-- paperclip:migration-compat requires_staging: pause gateway-token writers while PostgreSQL builds an index on the populated token table
CREATE INDEX IF NOT EXISTS "tool_mcp_gateway_tokens_expiry_idx" ON "tool_mcp_gateway_tokens" USING btree ("expires_at","id");
