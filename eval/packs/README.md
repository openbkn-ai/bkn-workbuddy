# 验证包

测试端专用：`expectFacts`、`forbidden`、`assertions` 只给验证执行器与人工评审使用，**不得**进入场景包、Skill、桥接器或被测模型的上下文。格式定义见 `schemas/eval-pack.schema.json`，TypeScript 校验器为 `packages/core/src/eval-pack.ts`（两者保持一致）。

## supply-ontology.v1.json

迁移自 `bkn-dsh@3f99235` 的 `docs/eval/supply-ontology.yaml`，数据锁定为 `bkn-samples@7b5b59c` 的 `supply_ontology_hand`。

### `expectTools` 映射（人工审阅）

原文件中的描述性条目改为 `read-v1` 工具名；执行器按实际平台 operations 判定，不做字符串包含比较。

| 用例 | 原 `expectTools` | 映射 | 理由 |
| --- | --- | --- | --- |
| orders-count-status | query_object_instance, 平台指标类查询 | query_object_instance, query_metric（任一） | R0a：两者都能得到 40 / 已确认 |
| finished-goods-inventory | query_object_instance, 库存/指标类查询 | query_object_instance, query_metric（任一） | R0a：实例查询与“库存可用量”指标按仓结果一致 |
| standard-lead-time | query_object_instance, 主数据查询 | query_object_instance | 主数据即“物料”对象类 |
| bom-structure | query_object_instance, BOM/关联查询 | query_object_instance, query_instance_subgraph（任一） | “产品BOM”对象类实例查询可得层级；关系查询为可选路径 |
| purchase-flow | query_object_instance, 单据流查询 | query_object_instance, query_instance_subgraph（任一） | 单据流需沿关系或多次实例查询 |
| sales-order-detail | query_object_instance, 明细查询 | query_object_instance | 明细即销售订单实例 |
| missing-object | query_object_instance | query_object_instance | 不变 |
| 三个故障用例 | — | — | 由 `precondition` 与 `adapter_status` / `interaction_count` 断言表达 |

### 与原文件的其他差异

- 故障用例的问题原文是“（先使平台 Token 失效，再问…）”这类操作说明，现拆为 `precondition` + 实际提问，便于执行器自动准备环境。
- `unauthorized-network` 标 `requires_real_authorization: true`：本地放行 stub 下按 D6 记 `blocked`。
- 新增一个追问 `orders-count-status-basis`（WB-05“未预写追问”的固定部分；现场未预写问题仍需人工提出）。
- `baseline` 记录核验方式与日期；BOM 与采购流基准未核验，断言只检查工具与收尾，事实部分交人工评审。
- 数字断言用 `(?<!\d)40(?!\d)` 形式避免把 400 误判为 40；语义正确性（口径、无编造）仍由人工按 `expectFacts` / `forbidden` 判定。
