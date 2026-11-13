# dsh-sandbox-presets-extra

[English](README.md) | 简体中文

为 DeepSeek Harness 注册**任意数量的可配置权限预设**。每个预设自行选择一种沙箱模式与
一种审批策略，并声明在该模式原本允许的范围**之上**再额外可写的目录。

这覆盖了 harness 能表达的两种方向——`workspace-write` 预设打开会话工作区旁边的目录，
以及 `read-only` 预设只打开它列出的那些目录、此外一概不开——且每种都可以有任意多个。

三种自带沙箱模式未被改动：`read-only`、`workspace-write`、`danger-full-access`
的含义、持久化 schema 与升级阶梯全部保持原样。

## 新增了什么

每个已配置的预设都会在权限选择器里占一项。一个典型配置：

| 预设 | 沙箱模式 | 审批 | 可写范围 |
| --- | --- | --- | --- |
| `read-only` | `read-only` | `ask` | 无 |
| `workspace-write` | `workspace-write` | `ask` | 工作区 + 临时目录 |
| `workspace-write-extra` | `workspace-write` | `ask` | 上述范围 **+ 它配置的目录** |
| `scratch` | `read-only` | `never` | **只有它配置的目录** |
| `danger-full-access` | `danger-full-access` | `never` | 全部 |

预设是**权限预设**，不是第四种 `SandboxMode`。这个区分正是关键：沙箱模式是一组封闭的
三值联合类型，会被写入 `sandbox/mode` 会话事件，并在会话恢复时由多个外部投影重新校验。
若在那里加入第四个值，**所有用过它的会话都将无法读取**。把已有的模式与额外行为打包在
一起，正是自带的 `auto` 预设采用的做法。

生效范围是**逐会话**的：仅当该会话最后记录的权限预设是某个预设时，该预设的目录才生效；
由于该选择存在于会话日志中，重启后依然保留。

被委派的会话会继承它。harness 只给子智能体一个裸的沙箱模式和一个 `never` 审批策略，
从不下发委派它的那个会话的预设名，因此子智能体自己的日志里没有记录任何选择，其可写目录
在提示词层与执行层都会为空。所以本插件改为从委派会话读回该选择，并要求委派时钉住的模式
正是该预设自己的模式——被刻意钉成另一种模式的子会话并没有获得该预设的写权限，此时不继承。
多级委派会一路向上找到第一个有记录的选择，并且授权是**每次调用重新读取**而非在委派那一刻
冻结，因此始终与那个会话保持一致——直到它改选了一个沙箱模式不同的预设，此时不是跟随，
而是授权结束。子会话终生只受一种模式约束，若授权说的模式已与约束它的模式不符，那描述的
就是 fence 实际会拒绝的边界。

由此有两条限制。选择是从**存活会话表**里读的，委派会话一旦不再存活（已结束、被清理、
尚未恢复），就无处可读，子会话也就不继承任何目录。另外，向上追溯的跳数是固定的一个小值，
正常链远达不到。

## 如何避免干扰

本插件不禁用、不替换、不重排任何自带行，而是**就地包装**两个正在运行的执行服务，
并在卸载时精确还原：

* 已挂载文件系统的包含性检查（`checkedTarget`）：当其拒绝发生时，针对当前预设授予的
  目录再重试一次；
* 沙箱 provider 的 `confine`：在 bwrap profile 中补上对应的 `--bind` 对，以及每个已配置
  设备的一条 `--dev-bind` 对。

fence 的重试**故意也覆盖 `read-only`**：自带 fence 在解析目标之前就直接拒绝 read-only
写入，因此包装会自行解析目标并与该预设的目录比较。这正是 `read-only` 预设也能授予写入
的原因，而它授予的恰好就是自己列出的那些目录。

模型可见的那段说明也需要同样修正，而且不能只是一句陈述。自带的 `sandbox:policy` 说明只按
mode 生成：`read-only` 下它声称什么都不可修改，`workspace-write` 下它只点名工作区。一句
平铺直叙的「本插件额外允许写入这些目录」很容易被读成从属于这条封闭边界，于是模型即使面对
预设已经放宽的路径，仍把会话当成只读。因此本插件**注册一个属于自己的运行时 context**，
紧跟在自带说明之后，内容写成明确的行为指令：

* 开头即声明它**覆盖上文那条 `Current DSH file policy` 说明**中、对下列目录的部分；
* 正面否定误读——**对这些目录而言本会话并非只读**——并给出按模式区分的例外措辞
  （`even under the read-only policy above` / `including those outside the session workspace`）；
* 把目录**逐行列出**，便于把路径逐项比对，并给出判定规则：路径属于其中之一或位于其下即可写，
  即使自带说明看起来在禁止；
* 明确要求模型**不要因为策略读起来像只读就拒绝、跳过、推迟或请求审批/提权**，而应正常调用
  工具，并遵循它返回的拒绝与提权指引，只有工具真的返回拒绝才算被拦——这正是自带
  `read-only` 说明自己已经给出的兜底；
* 点名当前选中的预设，声明授权**仅在该预设保持选中期间有效**，并规定后来出现、点名了不同预设的
  快照为准，从而让历史里残留的旧快照自行失效。

被委派的会话拿到的说明只改一处措辞：它自己从未记录过该选择，因此不说「预设已选中」，
而说**本会话由运行该预设的会话委派而来**，且授权跟随那个会话。若点名一个子会话自己的运行时
context 里并不存在的预设，恰恰就是这段说明要求模型「仅在快照点名时才相信」的那种说法。

选中的预设是 `danger-full-access` 时，本插件什么都不注入：该模式本身不限制任何路径，说这些
目录「额外可写」会是假命题而非修正。

注入采用自己的 context 而非改写自带那句，这一区别正是它能到达模型的原因。agent loop
在准备每次请求时会**从各自注册的 provider 重新解析每个运行时 context**，并把结果记录
成下一步读取的快照。因此，若本插件在 `system-prompt/assemble` 水波里改写别的子系统的
条目，这段文字会出现在直接调用 `assemble()` 的结果里，却**不会出现在任何真实步骤中**
——provider 自己的文本会把它替换掉。而属于本插件自己的 provider 能挺过这次刷新，并且
每次从当前选择重新渲染，因此那句说明会跟随预设切换。以自带的名字注册也不可行：
system-prompt 服务在同一层内以名字为键，重名会被拒绝。

这个 context 刻意**不标为 required**：自带 `sandbox:policy` 同样是可选 context，而
`suppressRuntimeContext()` 会把所有可选 context 一起丢掉。让两者同命运，才不会出现一句
「覆盖上文说明」却根本没有「上文」的自相矛盾。

由此产生两个性质，两者都很重要：

* **失败是安全的。** 若本插件未能加载，harness 仍保有原有的文件系统与沙箱，而不会
  失去它们。（另一条路——禁用自带行再插入替换行——没有这种回退：Cordis 拒绝为同一
  服务名注册两个提供者，因此也无法靠遮蔽来获得安全性。）
* **它是叠加式的。** 自带检查对它原本已处理的每种情况仍具权威性，只有它自身的拒绝
  才会被重新考虑。

## 配置

两种方式都支持。

### profile 配置

```yaml
- id: sandbox-presets-extra
  name: dsh-sandbox-presets-extra
  config:
    presets:
      # 会话工作区，外加几个缓存目录。
      workspace-write-extra:
        writableDirs:
          - /srv/shared-assets
          - ~/notes
      # 完全不可写工作区；只有这两个目录可写。
      scratch:
        sandbox: read-only
        approval: never
        writableDirs:
          - /tmp
          - ~/scratch
      # 只给受限命令开放设备节点，其余一律不可写。
      gpu:
        devices: [/dev/dri]
      # 带自定义标签的一项：客户端显示 `name`，缺省则回退到预设键。
      rust-tools:
        sandbox: workspace-write
        writableDirs: [~/.cargo, ~/.rustup]
        name: Rust tools
        description: Workspace plus the cargo and rustup caches
```

| 字段 | 默认值 | 含义 |
| --- | --- | --- |
| `sandbox` | `workspace-write` | `read-only`、`workspace-write` 或 `danger-full-access` |
| `approval` | `ask` | `ask` 或 `never` |
| `writableDirs` | `[]` | 在所选模式之上额外可写的目录 |
| `devices` | `[]` | 以 `--dev-bind` 开放给受限命令的设备路径 |
| `name` | 预设键 | 可选显示标签 |
| `description` | 无 | 可选单行描述 |

除非确实想要特定标签，否则不要给 `name`：缺省时选择器按预设键推导文字
（`workspace-write-extra` 显示为 `Workspace Write Extra`），而一旦提供标签，它会
**原样显示为英文**——因为客户端只为自己的内置预设做本地化。

目录必须是绝对路径；开头的 `~` 会被展开。符号链接会被解析，而**不存在或不是目录**的
条目会被**忽略并告警**，而不是被创建——授予一个没人指定的路径是危险的方向。展开是异步
的，因此某个目录只有在其自身展开成功之后才变为可写。若某个预设的 `sandbox` 或
`approval` 不是上述取值，它同样会被拒绝并告警，而不会被发布；保留名 `custom` 与
`auto` 也是如此。

以 `workspace:` 前缀开头的条目表示**相对于会话工作区**的路径，并按每个会话各自解析：

```yaml
workspace-write-extra:
  writableDirs:
    - /srv/shared-assets
    - workspace:notes        # <会话工作区>/notes
    - workspace:cargo/target # <会话工作区>/cargo/target
```

工作区下的目录在每次调用时解析，针对的是 harness 为调用会话折算出的根，而不是在插件加载
时解析一次：工作区属于会话，而插件在那一刻还不知道它。因此同一个条目在每个会话中含义
相同，模型可见的那段说明也会给出真实路径。

`workspace:` 条目必须是相对路径——`workspace:/etc` 与 `workspace:~/x` 会被拒绝并告警
——且不得包含 `..`；包含 `..` 会被直接拒绝而非悄悄钳制，以免配置逃出工作区。

解析出的目录在每次调用时还会再做一次文件系统校验：必须存在、必须是目录，且解析后的真实
路径仍位于会话工作区之内。工作区本身对会话可写，因此工作区下的子路径可以是会话放进去的
任何东西——若它是一个指向 `/` 的符号链接，授权就会被悄悄放大成对整个文件系统的写权限。
通不过校验的条目**不会被授予**，并会告警一次，于是提示词里列出的正好是围栏会放行的那几个
目录。同理，目录在写入 bwrap profile 之前还会再检查一次：bind 源若已消失，bwrap 会让整条
受限命令直接失败，代价是该会话所有 shell 命令都不可用，而不只是一次写入被拒。

`writableDirs` 只在受限模式下起作用。选了 `danger-full-access` 的预设仍可列出它们
（它们也仍会出现在表里），但该模式本身不做任何限制，因此这些目录不会带来额外的可写
范围，模型可见的那段说明也保持原样。

`devices` 之所以独立成一个字段，是因为它授予的东西无法用目录授权表达：自带 profile 用一个
空的 `--dev /dev` 盖住了整个根目录，于是宿主上的所有设备节点在沙箱内都不存在。列出的路径
——既可以是 `/dev/dri` 这样的节点目录，也可以是 `/dev/kvm` 这样的单个节点——会以
`--dev-bind <path> <path>` 重新挂回来。起作用的是 dev-bind 这种形式：普通 `--bind` 是
`nodev` 挂载，受限子进程即使能看见 `/dev/dri/renderD128`，打开时也会得到 `EACCES`，节点可见
却不可用。该路径只要求存在，因此与 `writableDirs` 不同，它可以是文件；它同样在构建 profile
之前再复查一次，理由与目录相同。

`devices` 里的路径不会放宽文件系统围栏：write/edit 工具仍然拒绝该路径，模型可见的那段说明
也不会提到它。配置一个设备等于把该节点的裸内核访问权交给受限命令——`/dev/dri` 能碰到宿主
的 GPU——因此应当刻意授予，而不是图方便。

与 `writableDirs` 一样，`devices` 只在受限模式下起作用。

预设顺序即配置顺序，也就是选择器展示它们的顺序。

### 设置页

`presets` 是 volatile 字段，因此整张表也会出现在设置页，编辑后对该 profile 内的所有
会话实时生效。设置页把它当作一整份文档来编辑，而非嵌套表单，因此上面的 profile patch
仍是书写它的自然位置。

## 与 harness 的兼容性

本插件不声明任何 `@deepseek-ai/dsh-*` 的 peer 范围，而 harness 只检查这类 peer。
因此它的兼容性建立在更精确也更狭窄的东西上：**它所读取并包装的那些已挂载服务的形状**
（外加一个 context 名）。这个形状才是代码实际使用的东西，其中服务部分由
`test/contract.test.js` 对**真实类**加以固定——所以任何移动了它的 harness 升级都会
立刻让测试失败，而不是在生产环境里悄悄收窄某个预设。

| 依赖 | 使用处 |
| --- | --- |
| `fs.checkedTarget(target, policy)` 以错误码 `FS_SANDBOX_DENIED` 拒绝 | `src/fs.js` |
| `fs.resolve(path)` 解析出带 `targetKey` 的 target | `src/fs.js` |
| `sandbox.confine(argv, policy, signal)` 解析为带 `argv` 的对象 | `src/provider.js` |
| policy 的 `mode`、`sessionId` 字段；结果的 `argv` 字段 | 两个包装 |
| `permissionPresets.presets` 与 `emitCatalogChanged()` | `src/service.js` |
| `permissionPresets.permissionState(session)`，返回记录的旋钮值 | `src/service.js` |
| `sandboxPolicy.resolve({session})`，返回 `workspaceRoot` 与 `sessionId` | `src/service.js` |
| `sessions.get(id)`，返回存活会话或 `undefined` | `src/service.js` |
| 提示词注册表：`context({name, order, text})` 与 `getContextOrder(name)` | `src/service.js` |

有若干性质让它在升级中保持稳健：

* 包装通过 `await` 调用自带方法，因此自带方法在同步与异步之间变化仍可工作。
* 两个包装都在**返回的对象**上操作，而不假设它是裸 argv，因此返回值新增字段仍可工作。
* 会话选中的预设从拥有它的服务读取，而非从 session projection store 读取——后者的
  `stateOf(session, key)` 已废弃且每个 key 告警一次；`permissionState` 与该服务自己
  `current` 所用的值相同，尚未完成的激活读作没有选择，而不是读作失败。

当某个已挂载服务完全不暴露预期的接缝时，插件会**每个服务告警一次**，并保持该实例
不变。它从不禁用自带行，因此任何意外 harness 形状下的失败模式都只是日志告警加自带
行为——绝不会变成文件系统或沙箱缺失。

已针对 harness `0.2.2-rc.2` 测试。该版本把最低 Node.js 提高到 `24.9`，因此本插件在
`engines` 中声明同一下限，CI 矩阵也从那里起步。
锁定的版本不只是一个下限：本插件所读取的 harness 形状在预发布之间会变——会话钉选、
委派策略、可写根注册在 `0.2.2-rc.2` 里都动过——因此契约套件跟随 `devDependencies` 中的
版本，运行了别的版本的 profile 属于套件未针对的情形。

## 平台支持

* **Linux + `bwrap`** —— 完全支持。配置的目录以 `--bind <dir> <dir>`、配置的设备以
  `--dev-bind <path> <path>` 加入 bubblewrap profile，因此受限命令与 write/edit 文件工具的
  行为一致，并且能打开被授予的设备。
* **Linux + `landlock`，以及 macOS `seatbelt`** —— write/edit 文件工具会被放宽，
  但受限命令不会，因为那些 profile 构建在本插件无法扩展的包内部。此时会告警一次，
  而不是假装支持。
* **Windows** —— 不支持。

## 文件结构

| 文件 | 作用 |
| --- | --- |
| `src/service.js` | `ctx.sandboxPresets`：持有已配置的预设表、按会话判定哪个预设生效、把 `workspace:` 条目按调用会话解析、包装两个执行服务、发布预设，并在自带沙箱说明旁注册模型可见的那段说明。 |
| `src/presets.js` | 归一化配置的预设表，并展开每个预设的目录。 |
| `src/fs.js` | 包装运行中文件系统的包含性检查。 |
| `src/provider.js` | 包装运行中沙箱 provider 的 `confine`。 |
| `src/roots.js` | 路径展开与包含性判定。 |
| `src/plan.js` | 纯函数式的 bwrap argv 变换。 |
| `cordis.patch.yml` | 插入唯一的一行插件。 |
| `test/contract.test.js` | 固定本插件所扩展的 harness 接缝。 |
| `test/support/host.js` | 真实的 Cordis 应用，以及运行中 `dsh` 所安装的 DSH 包的解析。 |
| `test/support/views.js` | 暴露契约套件必须读取的私有成员的视图。 |
| `scripts/require-no-skips.mjs` | 任一无作用例被跳过即判失败。 |

源码就是带 JSDoc 类型的纯 JavaScript，JSDoc 不便表达的类型放在 `src/contracts.d.ts`。
本包**从源码直接运行**：`main` 与 `exports` 都指向 `src/`，没有构建步骤，也没有
`lib/`——你编辑的就是 harness 加载的内容。

注意 profile 以**符号链接**（`link:`）安装本包并指向当前工作树，因此改动 `src/` 对
profile 立即生效，只需重载插件。

## 类型检查

```
pnpm run typecheck  # tsc -p tsconfig.json：对 src/ 与 test/ 做 checkJs
```

## 测试

```
pnpm test                        # node --test test/*.test.js
node scripts/require-no-skips.mjs # 同一批用例，遇到跳过即失败
```

`src/roots.js`、`src/plan.js`、`src/presets.js` 与两个包装都不依赖外部包，随处可运行。契约套件
与集成套件需要 DSH 包可被解析，因此需在已安装的 profile 中运行：契约套件固定真实的原生
接缝，集成套件则装配真实的文件系统与沙箱 provider，断言放宽生效以及卸载时的精确还原。
所有需要这些包的套件在包缺失时会带原因跳过，绝不空过。无需先行构建：套件直接针对
harness 加载的同一份 `src/` 运行。
