# Agent Note：实验性 SES Host 求值器

Status: implemented

[English](2026-08-14-experimental-ses-host-evaluator.md) | 中文

## 问题

动态 Cordis Host runner 在 `node:vm` 中对模型编写的普通 JavaScript 求值。精简的全局变量集合与 Context façade 可以减少意外访问，但 Host realm 的 helper 仍允许 constructor 逃逸，而且共享进程中的权限依旧可以触达。因此，该求值器无法证明 Host 半无法直接访问 Node 全局变量，也无法证明不同组件不能通过可变的全局变量与 intrinsic 相互通信。

该实验需要在不修改 Cordis core、动态 Package 格式、Guard 或 fiber 生命周期的前提下提供可比较的求值器。它还必须保留 `node:vm` 作为默认值，因为 SES lockdown 会不可逆地修改进程，并可能与 Host runner 之外的插件或依赖不兼容。

## 决策

`@deepseek-ai/dsh-cordis-host-runner` 在默认的 `"vm"` 之外提供实验性配置 `experimentalHostEvaluator: "ses"`。系统会导入 SES，并在第一个 SES 组件求值之前执行且仅执行一次 `lockdown()`。选择 `vm` 时不会初始化 SES。

每个 SES Package 的求值都使用一个新的具名 `Compartment`。它获得的 Host endowment 只有带插件标签的 console、`harness.defineTool`、`harness.registerTool`、`harness.handle`、`btoa`、`atob`、`TextEncoder` 与 `TextDecoder`；完整的 endowment 对象图会在求值前 harden。求值器运行现有的 async 函数体 wrapper，不增加模块 import 或 loader。

Compartment 名称与源码 URL 使用 Package id，使求值诊断可以区分不同版本。带标签的 console 使用稳定的插件 id，与 VM 求值器在更新及切换求值器时保持一致。

Host runner 对 Compartment 返回值执行现有的函数形式或对象形式插件校验，然后 harden 已校验的插件表面。该插件进入现有的 Context Guard 与 `cordis-dynamic` fiber，因此依赖挂起与重新激活、工具与 handler 归属、定时器、effect、激活回滚、stop 和 undefine 继续共用同一套生命周期实现。

SES 只限制经该路径求值的源码能从环境直接触达的对象。受 guard 保护的 Context façade 仍允许通过 `ctx.get(name)` 查找未声明的可选服务，而服务返回值可能传递顶层 Guard 未枚举的嵌套权限。静态插件、Client 代码与 Host 进程中的其他 JavaScript 均不在该实验范围内。

## 验证

隔离子进程用例在进程全局 lockdown 后运行，并验证未赋予的 Host 全局变量不可用、函数 constructor 与原型 constructor 逃逸被阻止、共享 intrinsic 与 endowment 已冻结、Compartment 全局变量彼此独立，以及动态函数和间接求值留在原 Compartment 中。用例还固定稳定的插件 console 标签和 Package 专属的源码标识。同一组用例还验证直接返回外部 Context 会被拒绝，并且求值或激活失败后不会留下存活的 Run、工具、handler、定时器或 effect。

兼容性用例覆盖对象形式与函数形式插件、依赖挂起与重新激活、工具和 Host handler 的注册与释放、定时器和 effect 清理、受支持的跨 realm JSON 与编码数据，以及可操作的求值、语法和激活错误 message。它们还固定 SES 2.3.0 的源码审查、secure-mode Date 与 Math 失败，以及 VM 教学式重定向的缺失。依赖构建的产物门禁会运行一个无需密钥、完整组装的 `dsh --profile headless` 进程，由它定义、激活、调用并停止一个 SES Host Package。该完整 profile 可以在 lockdown 后结束，因此实验不需要 Cordis callback 兼容层。

Host runner 产出的 JavaScript 从 126,601 字节增至 129,812 字节，声明文件从 53,278 字节增至 55,373 字节。精确版本 `ses@2.3.0` 的 npm artifact 压缩后为 1,128,009 字节，解压后为 4,717,114 字节；其三个传递性运行时依赖仍是外部包文件。SES 及其运行时闭包采用 Apache-2.0，并已列入生成的第三方声明。

## 考虑过的替代方案

**替换 `node:vm`。** 强制替换会 lockdown 每个 Host 进程，并移除用于比较的基线。显式的实验性选择器让现有行为与依赖兼容性继续作为默认值。

**在 Worker 或子进程中运行 SES。** 这需要为 Cordis 服务、callback、生命周期归属、错误与跨 realm 值设计 RPC 协议。它属于另一项可用性与进程隔离设计，不是测量仅 Host SES 兼容性的前提。

**模拟 `vmTimeoutMs`。** `Compartment.evaluate` 没有同等的同步超时。同一线程上的 timer 无法中断同步求值，而只把求值移入另一个执行单元会需要已排除的 RPC 层。因此 SES 路径会忽略 `vmTimeoutMs`，而不会承诺一个无效的截止期限。

**增加动态模块 import。** Package 源码继续采用没有 import hook 的 async JavaScript 函数体。模块加载会扩大权限，并且需要单独设计解析与策略。

**让每条 SES 诊断都使用 Package 标识。** 按版本区分的 Compartment 与源码标识对求值失败有用，但使用 Package 标签的 console 输出会与 VM 路径不同，并在每次更新时变化。因此 console 使用插件 id，而 Compartment 与源码标识保留 Package id。

## 后果

SES lockdown 是进程全局且不可逆的。选择实验性求值器的部署必须测试该进程中加载的每个插件与依赖；仓库将 SES 集成放在隔离子进程中，避免普通测试受执行顺序影响。

Harden endowment 对象图会在整个进程中冻结 Host `TextEncoder` 与 `TextDecoder` 的 constructor 和 prototype。缓存的 lockdown promise 也会保留拒绝结果，因为失败的 lockdown 可能已经部分修改进程；重试无法恢复已知的 lockdown 前状态。

define 时的 VM 编译会在铸出 id 之前拒绝无效的 JavaScript 语法。SES 2.3.0 随后会在激活时保守扫描原始 Host 源码，并拒绝看似 `import(...)` 的表达式与 HTML comment token，即使它们位于字符串或注释中也一样。Host 求值器会保留 SES 错误代码与源码位置，说明这是后续激活检查，并告诉作者应删除哪个 token；它不会增加 parser、源码重写或模块 loader。

SES 共享 intrinsic 会让 `Date.now()`、`new Date()` 与 `Math.random()` 抛出 secure-mode `TypeError`。未赋予的 `require`、`fetch` 与定时器全局变量也会直接缺失，而不会使用 VM 求值器的教学式重定向。这些测量差异仍是限制，不会变成新的 endowment 或兼容层。

SES 的错误驯化会保留错误 message，但可能省略或删减 stack。现有 `node:vm` 语法预检在 lockdown 后仍可操作，但当被驯化的 stack 省略出错源码行时，专门针对 TypeScript 的提示可能退回为通用的 async 函数体与括号平衡诊断。

SES 路径没有同步执行上限，与 Host 共享线程和堆，并通过 Context façade 暴露存活服务的权限。它是用于验证环境直接可达性与生命周期兼容性的仅 Host 概念验证，不是生产级 containment、拒绝服务防护，也不主张所有不可信 JavaScript 表面都受到隔离。
