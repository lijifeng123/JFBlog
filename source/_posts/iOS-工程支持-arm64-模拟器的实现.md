---
title: iOS 工程支持 arm64 模拟器的实现
date: 2026-10-26 23:05:44
tags: 
---

## 背景

工程里有一批预编译的三方库，只带真机 arm64 切片；Flutter 产物同样只有真机 arm64。在 Apple Silicon 上想用 arm64 模拟器，需要的是「platform 为 iOS Simulator」的 arm64 二进制，两者不能互用。历史上靠手工替换 Zoom、NlsSdk 这类库来绕过，不进流程也容易漏。

工程默认状态是：Podfile 给 Pods 工程设置 `EXCLUDED_ARCHS[sdk=iphonesimulator*] = arm64`，即模拟器只能编 x86_64 走 Rosetta。但这条退路对部分库也无效——nuisdk 只有 `armv7 + arm64`，Flutter 产物只有真机 `arm64`。

## 根因：Mach-O 的平台标记

真机 arm64 和模拟器 arm64 的**架构名完全一样**，`lipo -archs` 区分不出来。差别在二进制内部：

```
$ xcrun vtool -show-build <binary> | grep platform
ios-arm64                    → platform IOS
ios-arm64_x86_64-simulator   → platform IOSSIMULATOR
```

对应到构建期，链接会报 `building for iOS Simulator, but linking in object file built for iOS`；即使侥幸链上，运行期 dyld 也会因平台不兼容拒绝加载。

所以任何方案的本质都一样：**提供一个 platform = IOSSIMULATOR 的二进制**。区别只在于这个二进制从哪来——XCFramework 靠上游打包时的带外元数据，老式 flat `.framework` / `.a` 没有这个位置，只能改二进制本身。

## 总体思路

不改动仓库任何文件，在本地 `.sim/` 目录生成一套模拟器版副本，再通过 CocoaPods 生成的构建配置，让模拟器构建看到副本、真机构建完全看不到。

关键取舍是：**不改链接标志**。`-framework nuisdk`、`-l"WeChatSDK"` 这些来自 podspec 和工程文件，改它们等于改仓库；唯一能在「标志不变」的前提下换实现的位置，是搜索路径的顺序——放在最前，同名文件优先命中。

## 开关

`.sim/enabled` 是否存在，决定 Podfile 走哪条分支：

```ruby
def simulator_mode?
  File.exist?(File.join(__dir__, '.sim', 'enabled'))
end
```

用文件而不是环境变量，是因为开关状态不落在任何被跟踪的文件里，`git status` 始终干净，其他人拉到的还是原样 Podfile。`.sim/` 在 `.gitignore` 中。

## 配置分流

`pod install` 时，post_install 里做三件事。

### 1. 放开架构限制

```ruby
target.build_configurations.each do |config|
  config.build_settings['EXCLUDED_ARCHS[sdk=iphonesimulator*]'] = 'i386'
  config.build_settings['VALID_ARCHS[sdk=iphonesimulator*]']    = 'arm64'
end
```

有些 podspec 自己把模拟器限定成 x86_64 或显式排除了 arm64，逐个 target 覆盖掉。

### 2. 搜索路径前置

改写 aggregate target（`Pods-<Target>`）的 xcconfig：先删掉其中所有带 `[sdk=iphonesimulator*]` 的 `EXCLUDED_ARCHS` / `VALID_ARCHS` / `FRAMEWORK_SEARCH_PATHS` / `LIBRARY_SEARCH_PATHS` 行，再追加：

```
FRAMEWORK_SEARCH_PATHS[sdk=iphonesimulator*] = "${PODS_ROOT}/../.sim/overlay/frameworks" "${PODS_ROOT}/../.sim/flutter" $(inherited) <原有内容>
LIBRARY_SEARCH_PATHS[sdk=iphonesimulator*]   = "${PODS_ROOT}/../.sim/overlay/libs" $(inherited) <原有内容>
```

选择 aggregate xcconfig 而不是各个 pod 的 xcconfig，原因是它被设成了 App target 构建配置的 `baseConfigurationReference`，App target 和所有子工程都继承它，改一处即全局生效。

路径上 `PODS_ROOT = ${SRCROOT}/../Pods`，所以 `${PODS_ROOT}/../.sim/...` 正好等于仓库根下的 `.sim/...`。

这里还有一个容易被忽略的点：App target 自己在 pbxproj 里的搜索路径把 `$(inherited)` 放在列表**第一位**，所以继承来的 overlay 路径会插到工程自带路径**之前**，最终顺序是：

```
.sim/overlay/frameworks → .sim/flutter → Pods 路径 → 工程自带路径
```

链接器取第一个命中，`-framework nuisdk` 就落到了副本上。

### 3. 嵌入脚本改写

链接到正确的二进制不等于打包里就是它。`Pods-<Target>-frameworks.sh` 需要处理两件事：

```sh
# Flutter 目录整体切到 .sim/flutter
UMU_SIM_FLUTTER_DIR="${PODS_ROOT}/../.sim/flutter"   # 真机时为 ${PODS_ROOT}/../Flutter/Flutter

# nuisdk：主工程 Embed Frameworks 先于本脚本执行，这里再覆盖一次
if [ "${PLATFORM_NAME}" = "iphonesimulator" ] && [ -d "${TARGET_BUILD_DIR}/${FRAMEWORKS_FOLDER_PATH}/nuisdk.framework" ]; then
  install_framework "${PODS_ROOT}/../.sim/overlay/frameworks/nuisdk.framework"
fi
```

脚本改写用 `script.include?('UMU_SIM_FLUTTER_DIR')` 做幂等保护，重复 `pod install` 不会叠加插入。

## 不在 CocoaPods 里的 SDK 怎么处理

工程里有相当一部分库是直接放进仓库、由 App target 自己引用的（WebP、WebPDecoder、liblame.a、UMMobClick、libWeChatSDK.a、nuisdk）。它们走的是 App target 在 pbxproj 里的两组设置：

```
FRAMEWORK_SEARCH_PATHS = ( "$(inherited)", "$(PROJECT_DIR)/UMU/OpenSource/AliNls", ... )
LIBRARY_SEARCH_PATHS   = ( "$(inherited)", "$(PROJECT_DIR)/UMU/UMU_Core/Lame", ... )
```

因为 App target 的 base configuration 就是 Pods 生成的 aggregate xcconfig，上面第 2 步里的条件设置自然被 App target 继承，**不需要修改工程文件**。

overlay 目录按类型摊平，不复刻仓库里的多层结构：

| 源位置 | overlay 位置 |
|---|---|
| `UMU_Teacher/UMU/OpenSource/AliNls/nuisdk.framework` | `.sim/overlay/frameworks/nuisdk.framework` |
| `Pods/FirebaseAnalytics/Frameworks/FirebaseAnalytics.framework` | `.sim/overlay/frameworks/FirebaseAnalytics.framework` |
| `UMU_Teacher/UMU/OpenSource/WeChat-2.0.5/libWeChatSDK.a` | `.sim/overlay/libs/libWeChatSDK.a` |
| `UMU_Core/UMU_Core/Lame/liblame.a` | `.sim/overlay/libs/liblame.a` |

规则是 `.framework` 进 `frameworks/`、`.a` 进 `libs/`。搜索路径是目录级的，只要目录在前、文件名一致就命中。

需要区分**链接**和**嵌入**两条路：

- 链接靠搜索路径，静态库只需要这一步；
- 嵌入走 App target 的 Embed Frameworks build phase，用的是 pbxproj 里的文件引用，**跟搜索路径无关**。

`SOURCES` 清单里 12 个库，实测 11 个是静态库，只有 nuisdk 是动态库。这解释了为什么只有它需要额外改嵌入脚本——静态库会被链进主二进制，不存在独立嵌入。交叉验证方式：`grep install_framework` 所有 `Pods-*-frameworks.sh`，其中没有任何 Bugly / opencv2 / Fabric / Firebase 的 install 行。

## overlay 的生成

`SOURCES` 列了 12 项，`is_fresh` 用 `shasum` 和上次的 `*.sha` 比对，源二进制没变就跳过，所以每次 `pod install` 都跑 refresh 的代价接近零。

转换由 `arm64_to_sim.py` 完成，按三种形态分别处理：

| 形态 | 做法 |
|---|---|
| 静态库（`.a`） | 逐个 ar 成员改平台标记，再用 `libtool` 重新打包 |
| 动态库 | `vtool -set-build-version` 改平台，再 ad-hoc 重签 |
| fat 二进制 | 只把 arm64 切片 thin 出来改，原有 x86_64 切片保留，`lipo -create` 合并回去 |

静态库这一段是整个方案里最需要小心的地方。`vtool` 处理 `ar` 归档会失败，因为它在 Mach-O 加载命令区没有预留空间时改不动，所以要自己动手：

1. 把每个目标文件的 `LC_VERSION_MIN_IPHONEOS` 替换成 `LC_BUILD_VERSION`，platform 置 7（IOSSIMULATOR）；
2. 为此需要撑大加载命令区，随之把 symtab、segment、reloc、linkedit 等**所有文件偏移同步后移**，后移量取各段最大对齐的整数倍，保证对齐关系不变；
3. 用 `libtool` 重新打包。

framework 的拷贝策略是整目录 `cp -R`（保留 `Headers`、`Info.plist`），只替换内部那个二进制；二进制被改后原 `_CodeSignature` 失效，动态库需要整体重签一次，静态库无所谓——它最终会被链进主二进制。

## Flutter 产物

仓库里 `Flutter/Flutter/` 下的产物只有真机 arm64 切片，所以模拟器需要单独编一份：

```bash
flutter build ios-framework --debug --no-profile --no-release --no-plugins --no-tree-shake-icons
```

- 从同级 `umu_flutter` 仓编译，来源必须显式指定（`current` / `release` / `same` / 分支名），非 `current` 时用临时 worktree，不动本地 Flutter 仓的分支和未提交改动；
- 只抽 `ios-arm64_x86_64-simulator` 切片下的 `App.framework` + `Flutter.framework` 到 `.sim/flutter`；
- `--no-plugins`：插件原生代码仍由 Pods 里的插件 pod 提供，不进这份产物；
- 因为 `--debug`，`App.framework` 里是 `kernel_blob.bin` + `isolate_snapshot_data`（JIT），与真机 release 的 AOT 产物行为有差异；
- 记录 `flutter_source` / `flutter_commit` / `ios_flutter_rev`，最后一个用于判断这份产物是否在 iOS 侧产物更新前生成，过期时给出提示。

有个实际的坑：`Pods-*-frameworks.sh` 的输入没变时 Xcode 会跳过执行，导致嵌入的仍是旧产物，所以产物生成后会 `touch` 一次相关脚本。

## 与 XCFramework 的关系

工程里已有 5 个依赖用的是 XCFramework：WebRTC、MicrosoftCognitiveServicesSpeech、QCloudRealTime、RecaptchaEnterpriseSDK、TensorFlowLiteC。它们从来不需要处理，原因值得对比。

XCFramework 是一个目录包，按平台各存一份切片，外加一张说明表。以 `WebRTC.xcframework` 为例（整个包 141M）：

```
WebRTC.xcframework/
├── Info.plist
├── ios-arm64/                      → 12M，仅 arm64，platform IOS
├── ios-arm64_x86_64-simulator/     → 27M，arm64 + x86_64，platform IOSSIMULATOR
├── ios-arm64_x86_64-maccatalyst/
├── macos-arm64_x86_64/
└── tvos-* / xros-*
```

`Info.plist` 里显式登记了每个切片的平台与架构：

```
{ LibraryIdentifier: "ios-arm64_x86_64-simulator",
  SupportedPlatform: "ios",
  SupportedPlatformVariant: "simulator",     ← 模拟器
  SupportedArchitectures: [arm64, x86_64] },
{ LibraryIdentifier: "ios-arm64",
  SupportedPlatform: "ios",                  ← 无 variant = 真机
  SupportedArchitectures: [arm64] }
```

差别就在这里：**模拟器切片的架构名同样是 arm64，是 `SupportedPlatformVariant` 这个带外字段把两者区分开的**。flat `.framework` 没有地方放这个字段，所以 `lipo` 无论如何都分不出来。

XCFramework 不能直接链接，必须先解包。CocoaPods 在 Pods.xcodeproj 里为每个带 xcframework 的 pod target 加了一个 `[CP] Copy XCFrameworks` 脚本阶段，执行 `Pods-<Name>-xcframeworks.sh`，按当前构建平台挑切片：

```bash
target_variant=""
if [[ "$PLATFORM_NAME" == *"simulator" ]]; then target_variant="simulator"; fi
if [[ "$EFFECTIVE_PLATFORM_NAME" == *"maccatalyst" ]]; then target_variant="maccatalyst"; fi
# 再逐个切片比对：variant 一致，且切片 archs 覆盖当前 $ARCHS
```

选中的切片被 rsync 到 `${PODS_XCFRAMEWORKS_BUILD_DIR}/<Name>/`，到这里才变成普通的 `.framework`，然后走常规通道：xcconfig 里的 `-iframework` 负责链接，`Pods-*-frameworks.sh` 里的 `install_framework` 负责嵌入。

一个排查线索：如果某个 XCFramework 缺模拟器切片，这里不会报错，只打一行 warning 然后 `return`，失败会推迟到后面的链接阶段。

对比下来，overlay 方案本质上是**给老式二进制手工造出 XCFramework 的效果**：XCFramework 由上游备好切片、工具链自动挑；老式库由本地脚本补切片、靠搜索路径顺序冒充。判断一个新库要不要处理，标准可以简化为——看它有没有 `ios-arm64_x86_64-simulator` 这样的模拟器切片。

## 隔离性

保证真机与上线包不受影响，靠三个条件同时生效：

1. 所有架构和搜索路径 build setting 都带 `[sdk=iphonesimulator*]` 后缀；
2. overlay 目录只出现在这两条带后缀的搜索路径里，真机构建的搜索列表里没有 `.sim/`；
3. 嵌入脚本里的替换都判断 `PLATFORM_NAME == iphonesimulator`。

所以真机链接的仍是仓库原件，App 包内也不会混入模拟器二进制。默认关闭，`.sim/` 不入库，pod install 是唯一入口，别人和 CI 的行为零变化。

## 使用方式

```bash
Shell/simulator/sim_toggle.sh flutter <来源>   # 生成/更新 Flutter 模拟器产物
Shell/simulator/sim_toggle.sh on              # 打标 + pod install
Shell/simulator/sim_toggle.sh status          # 模式、产物来源、各库转换状态
Shell/simulator/sim_toggle.sh off             # 摘标 + pod install 还原
```

开启后在 Xcode 里 Clean Build Folder，再选 arm64 模拟器运行。

## 边界与已知问题

- 只解决加载与链接。相机、扫码、AI 检测、推送、微信分享登录在模拟器上不可用，这是模拟器本身的能力限制。
- Flutter 只有 debug(JIT)，没有 release。
- 新增「只有真机切片」的库需要人工加进 `SOURCES`，做不到全自动。
- 已知问题：SVGKit 在 arm64 模拟器下识别不了，启动后第一张 SVG 不显示，真机无影响。