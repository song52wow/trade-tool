-- 008_algo_order_ids：Binance 把合约条件单迁到 Algo Order API 之后的列语义修正。
--
-- 背景：止盈止损的 `STOP_MARKET` / `TAKE_PROFIT_MARKET` 已从 `POST /fapi/v1/order`
-- 迁到 `POST /fapi/v1/algoOrder`（打老接口会被拒：*Order type not supported for this
-- endpoint*）。条件单的回执是 **algoId**，撤销走 `DELETE /fapi/v1/algoOrder`，
-- 与普通订单的 orderId 是**两套互不通用的编号空间**。
--
-- 因此这两列存的已经不再是普通订单号。列名不改的话，读代码的人会理所当然地拿它去
-- `DELETE /fapi/v1/order` 撤单，然后拿到「订单不存在」，而根因是命名在说谎。
-- 按 AGENTS.md 硬性约定 2（跨语言契约 = 数据库 schema），改名与两侧读写同提交。
--
-- 幂等：只做重命名，且用 to_regclass 判存在，重复执行不报错。

DO $$
DECLARE
    tbl regclass := to_regclass('risk_bracket');
BEGIN
    IF tbl IS NULL THEN
        RAISE EXCEPTION 'risk_bracket 不存在，无法执行 008（请先应用 006）';
    END IF;

    -- 列是否存在必须按**本表**判断，不能查 information_schema.columns：
    -- 那个视图不带 schema 过滤，而同一库里可能有多张同名表（测试就在随机 schema 上跑迁移）。
    -- 一旦命中别处的同名列，`NOT EXISTS` 会为假，改名被静默跳过，紧接着 COMMENT 就报
    -- “column does not exist”——失败点离根因十万八千里。
    IF EXISTS (
        SELECT 1 FROM pg_attribute
         WHERE attrelid = tbl AND attname = 'tp_order_id' AND NOT attisdropped
    ) AND NOT EXISTS (
        SELECT 1 FROM pg_attribute
         WHERE attrelid = tbl AND attname = 'tp_algo_id' AND NOT attisdropped
    ) THEN
        ALTER TABLE risk_bracket RENAME COLUMN tp_order_id TO tp_algo_id;
    END IF;

    IF EXISTS (
        SELECT 1 FROM pg_attribute
         WHERE attrelid = tbl AND attname = 'sl_order_id' AND NOT attisdropped
    ) AND NOT EXISTS (
        SELECT 1 FROM pg_attribute
         WHERE attrelid = tbl AND attname = 'sl_algo_id' AND NOT attisdropped
    ) THEN
        ALTER TABLE risk_bracket RENAME COLUMN sl_order_id TO sl_algo_id;
    END IF;
END
$$;

COMMENT ON COLUMN risk_bracket.tp_algo_id IS
    '止盈条件单的 algoId（Binance Algo Order API）。不是普通 orderId，撤销必须走 DELETE /fapi/v1/algoOrder';
COMMENT ON COLUMN risk_bracket.sl_algo_id IS
    '止损条件单的 algoId（Binance Algo Order API）。不是普通 orderId，撤销必须走 DELETE /fapi/v1/algoOrder';
