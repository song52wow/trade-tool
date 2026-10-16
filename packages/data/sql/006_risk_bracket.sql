-- 006_risk_bracket：v0.4.0 止盈止损的执行记录。
--
-- 存在的理由只有一个：**同一笔买入成交只能被处理一次**。
-- 用户数据流会重投事件（listenKey 续期、断线重连都会重放最近的状态），
-- 而止盈止损是**会真实下单**的动作——重复处理一次就是一倍的仓位在跑，
-- 且第二组单会把第一组吃掉，账面上的止损位和用户以为的那个不是一回事。
--
-- 因此这里用 **(exchange, symbol, entry_order_id)** 做主键：
-- 交易所的入场订单号唯一标识「哪一次买入成交」，冲突即代表已处理过。
-- 插入用 ``ON CONFLICT DO NOTHING`` 当作**先占坑再动手**的闸门——
-- 占坑和下单不能合成一个事务（一个在 PG、一个在交易所），
-- 所以宁可「占坑后下单失败、留下 failed 行」，也不要「下单成功但没记下来、
-- 重连后又被挂一次」。
--
-- 约定沿用既有（R-1）：
--   * 时间戳一律 bigint（epoch 毫秒），不用 timestamptz；
--   * 本文件必须可重复执行（幂等）；
--   * 表结构的唯一来源就是本文件，TS 与 Python 都不得另持影子定义。

CREATE TABLE IF NOT EXISTS risk_bracket (
    exchange        text             NOT NULL,
    symbol          text             NOT NULL,
    -- 交易所的入场订单号（BUY 那笔）。幂等的锚点。
    entry_order_id  text             NOT NULL,
    entry_price     double precision NOT NULL,
    entry_time      bigint           NOT NULL,
    filled_qty      double precision NOT NULL,
    -- 仓位方向：LONG / SHORT。由入场成交的买卖方向推出。
    position_side   text             NOT NULL,
    -- 算止盈止损所依据的 ATR 快照。随记录一起存，事后能回答
    -- 「当时为什么止损在那个价」，而不必复算（复算会因数据回补而变）。
    atr             double precision NOT NULL,
    atr_period      integer          NOT NULL,
    atr_interval    text             NOT NULL,
    atr_window_from bigint           NOT NULL,
    atr_window_to   bigint           NOT NULL,
    stop_price      double precision NOT NULL,
    take_profit     double precision NOT NULL,
    -- 两张条件单的订单号。挂上之后才回填。
    tp_order_id     bigint,
    sl_order_id     bigint,
    state           text             NOT NULL,
    -- 失败原因常驻可见：挂不上就必须是「看得见的失败」，不是「什么都没发生」。
    last_error      text,
    created_at      bigint           NOT NULL,
    updated_at      bigint           NOT NULL,
    CONSTRAINT risk_bracket_pkey PRIMARY KEY (exchange, symbol, entry_order_id),
    CONSTRAINT risk_bracket_position_side_check CHECK (position_side IN ('LONG', 'SHORT')),
    -- armed      两张条件单都已挂上
    -- take_profit / stop_loss  已被交易所成交（另一张由交易所自动撤销）
    -- cancelled  持仓被手动平掉，两张单被交易所撤销
    -- failed     算 ATR 或下单失败，未挂上任何单
    CONSTRAINT risk_bracket_state_check CHECK (
        state IN ('armed', 'take_profit', 'stop_loss', 'cancelled', 'failed')
    ),
    -- 已挂上就必然有止损价与止盈价，且 ATR 必须为正。
    -- ATR <= 0 会让止损位正好落在入场价上（当场平仓），因此在表上直接禁止。
    CONSTRAINT risk_bracket_positive_atr CHECK (atr > 0),
    CONSTRAINT risk_bracket_prices_check CHECK (stop_price > 0 AND take_profit > 0)
);

-- 排查用：「这个标的现在有哪些还挂着的单」。按 updated_at 倒序取最新即可，
-- 不需要另一张索引表——这张表的行数等于成交笔数，不随时间膨胀。
CREATE INDEX IF NOT EXISTS risk_bracket_symbol_updated
    ON risk_bracket USING BTREE (exchange, symbol, updated_at DESC);