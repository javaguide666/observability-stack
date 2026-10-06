-- ClickVisual 日志库。qryn 把原文写在 obs_logs.samples_v3，这里只做查询视图。
-- app_logs：业务 namespace=wealth，拆出级别 / 模块 / 类 / traceId，正文去掉 logback 头。
-- k8s_logs：kube-system、日志组件等，不和业务混在一张表里。

CREATE OR REPLACE VIEW cv_logs.app_logs AS
SELECT
    toDateTime(intDiv(s.timestamp_ns, 1000000000)) AS _time_second_,
    trim(BOTH '\n' FROM if(
        match(s.string, '^\\d{4}-\\d{2}-\\d{2} \\d{2}:\\d{2}:\\d{2}\\.\\d{3} \\['),
        replaceRegexpOne(
            s.string,
            '^\\d{4}-\\d{2}-\\d{2} \\d{2}:\\d{2}:\\d{2}\\.\\d{3} \\[[^\\]]*\\] \\[[^\\]]*\\] (?:TRACE|DEBUG|INFO|WARN|ERROR)\\s+\\S+:\\d+ - ',
            ''
        ),
        s.string
    )) AS _raw_log_,
    extract(
        s.string,
        '^\\d{4}-\\d{2}-\\d{2} \\d{2}:\\d{2}:\\d{2}\\.\\d{3} \\[[^\\]]*\\] \\[[^\\]]*\\] (TRACE|DEBUG|INFO|WARN|ERROR)'
    ) AS level,
    multiIf(
        JSONExtractString(t.labels, 'app') = 'wealth-admin-server', 'admin',
        JSONExtractString(t.labels, 'app') = 'wealth-system-server', 'system',
        JSONExtractString(t.labels, 'app') = 'wealth-auth', 'auth',
        JSONExtractString(t.labels, 'app') = 'wealth-ecommerce-server', 'ecommerce',
        JSONExtractString(t.labels, 'app') = 'wealth-gateway', 'gateway',
        JSONExtractString(t.labels, 'app') = 'wealth-freedom-web', 'admin-web',
        JSONExtractString(t.labels, 'app') = 'wealth-ecommerce-web', 'shop-web',
        JSONExtractString(t.labels, 'app')
    ) AS module,
    extract(
        s.string,
        '^\\d{4}-\\d{2}-\\d{2} \\d{2}:\\d{2}:\\d{2}\\.\\d{3} \\[[^\\]]*\\] \\[[^\\]]*\\] (?:TRACE|DEBUG|INFO|WARN|ERROR)\\s+(\\S+):\\d+'
    ) AS logger,
    extract(
        s.string,
        '^\\d{4}-\\d{2}-\\d{2} \\d{2}:\\d{2}:\\d{2}\\.\\d{3} \\[[^\\]]*\\] \\[([^\\]]*)\\]'
    ) AS trace_id
FROM obs_logs.samples_v3 AS s
LEFT ANY JOIN
(
    SELECT
        fingerprint,
        any(labels) AS labels
    FROM obs_logs.time_series
    GROUP BY fingerprint
) AS t ON s.fingerprint = t.fingerprint
WHERE s.string != ''
  AND JSONExtractString(t.labels, 'namespace') = 'wealth';

CREATE OR REPLACE VIEW cv_logs.k8s_logs AS
SELECT
    toDateTime(intDiv(s.timestamp_ns, 1000000000)) AS _time_second_,
    trim(BOTH '\n' FROM s.string) AS _raw_log_,
    JSONExtractString(t.labels, 'namespace') AS namespace,
    JSONExtractString(t.labels, 'app') AS app,
    JSONExtractString(t.labels, 'pod') AS pod
FROM obs_logs.samples_v3 AS s
LEFT ANY JOIN
(
    SELECT
        fingerprint,
        any(labels) AS labels
    FROM obs_logs.time_series
    GROUP BY fingerprint
) AS t ON s.fingerprint = t.fingerprint
WHERE s.string != ''
  AND JSONExtractString(t.labels, 'namespace') != 'wealth';
