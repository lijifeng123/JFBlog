---
title: flutter 随意笔记
date: 2026-04-27 16:50:24
tags: 
---

# flutter 随意笔记

## 一、混合开发内存分析

### Flutter 页面为什么比 Native 页面多 ~20MB

Flutter 不使用 UIKit 的渲染体系，而是通过 Metal 自己画每一个像素。每个 `FlutterViewController`（Container）都持有一个独立的 `CAMetalLayer`，需要分配帧缓冲区：

```
iPhone 14 屏幕：2532 × 1170 × 4 bytes × 2~3 个缓冲（triple buffering）≈ 20MB
```

UIKit Native 页面共用系统的 `CAMetalLayer`，由 CoreAnimation 统一合成，新增页面的内存增量只是 UIView 数据结构本身（KB 级）。

### FlutterBoost 单引擎多容器架构

```
1 个 FlutterEngine（Dart VM + 运行时）：一次性 ≈ 15MB
每个 Flutter 页面 = 1 个 FBFlutterViewContainer（独立 CAMetalLayer）：≈ 20MB/个
```

导航栈内存累计：

```
[Native][Flutter A][Flutter B][Flutter C]
              ↑20MB     ↑20MB     ↑20MB
```

### 为什么 Flutter C → Flutter D 也会 +20MB

每个 Container 创建时会调用 `surfaceUpdated:YES` 分配 Metal surface。而 `FBFlutterViewContainer` 对 `surfaceUpdated:` 加了守卫：

```objc
- (void)surfaceUpdated:(BOOL)appeared {
    if (self.engine && self.engine.viewController == self) {
        [super surfaceUpdated:appeared];
    }
}
```

push Flutter D 时：
1. `ENGINE.viewController = D`
2. D 调用 `surfaceUpdated:YES` → 分配 Metal surface：+20MB
3. C 的 `viewDidDisappear` 尝试调 `surfaceUpdated:NO`，守卫判断 `engine.viewController == D ≠ C` → **拦截**，C 的 Metal surface 不释放

结论：**每个在导航栈里的 Flutter Container，都独占约 20MB Metal 内存，且被遮盖后不会释放。**

### 纯 Flutter vs 混合开发内存对比

| 架构 | Metal surface | 3 个 Flutter 页面 |
|------|--------------|-----------------|
| 纯 Flutter | 全局共用 1 份 | ≈ 15MB(VM) + 20MB(surface) = 35MB |
| 混合（FlutterBoost） | 每个 Container 独占 1 份 | ≈ 15MB(VM) + 20MB × 3 = 75MB |

### 单引擎 vs 多引擎对比

| | 单引擎（FlutterBoost） | 多引擎 |
|--|--|--|
| Dart VM | 15MB × 1 | 15MB × N |
| Metal surface | 20MB × N | 20MB × N |
| 3 个页面 | ≈ 75MB | ≈ 105MB |

**共用一个引擎是混合开发内存最优方案。**

---

## 二、Metal Surface

Metal 是苹果的 GPU 图形框架（类似 Android 的 Vulkan），Metal surface 是 Flutter 用来绘制画面的「画布」（GPU 帧缓冲区）。

- UIKit：全 App 共用一个 CAMetalLayer，系统统一管理
- Flutter：每个 FlutterViewController 独占一个 CAMetalLayer，自己控制每个像素

Flutter 这样设计的原因：完全绕过 UIKit 控件体系，实现跨平台 UI 一致性，代价是必须独占 GPU 内存画布。

---

## 三、Dart VM

### Debug 模式

```
Dart 代码 → Dart VM 解释执行（或 JIT 编译）
作用：执行引擎 + 管家
支持热重载、断点调试
内存占用：≈ 30~50MB
```

> iOS 真机不支持 JIT（苹果禁止运行时生成可执行代码），真机 Debug 走解释执行。

### Release 模式

```
Dart 代码 → AOT 编译 → ARM 机器码（.dylib）→ 打包进 App，CPU 直接执行
Dart VM 退化为「管家」角色：
  - GC（垃圾回收）
  - Isolate 调度（多线程）
  - 异步事件循环（async/await、Future）
  - 基础运行时服务
内存占用：≈ 10~15MB
```

---

## 四、Flutter 三棵树

### Widget Tree（配置树）

```dart
Column(
  children: [
    Text('Hello'),
    Button('Click'),
  ],
)
```

- Widget 是轻量的「配置描述」，类似装修图纸
- `setState()` 触发 Widget Tree 重建，创建销毁成本极低

### Element Tree（实例树）

- Element 是 Widget 的实例化，持有 State
- `setState()` 后，Element 对比新旧 Widget（diff）：
  - 类型相同 → 复用 Element，State 保留 ✅
  - 类型不同 → 销毁重建，State 丢失 ❌
- Element 是三棵树的「中间人」，连接 Widget 和 RenderObject

### RenderObject Tree（渲染树）

- 负责真正的布局（layout）和绘制（paint）
- 收到更新后还会再 diff：
  - layout 脏：重新计算大小位置（贵）
  - paint 脏：只重新绘制（便宜）
  - 都没变：什么都不做 ✅
- 最终输出给 Metal surface

### 三棵树协作流程

```
Widget（图纸）→ Element（工头，管复用和状态）→ RenderObject（工人，真正干活）→ Metal surface
```

| 树 | 类比 | 特点 |
|----|------|------|
| Widget Tree | 装修图纸 | 轻量，随时重建 |
| Element Tree | 工头 | 管状态，判断复用 |
| RenderObject Tree | 工人 | 重量级，真正干活 |

---

## 五、setState 与重绘

### setState() 之后的流程

```
setState()
  → 标记当前 Element 为 dirty
  → 下一帧重建 dirty Element 的子树（Widget 重建）
  → Element diff 新旧 Widget
  → RenderObject 按需更新（layout / paint / 不动）
```

### 整页 setState 性能影响

Widget 重建本身很便宜，但以下场景有真实影响：

- **高频 setState**（动画、滚动）：60fps 下积累成本不可忽视
- **build 方法里有重计算**：每次 setState 都执行，是真正瓶颈
- **大列表**：大量 Element diff 也有成本

### const 是真正零成本

```dart
const Text('标题')  // Flutter 直接跳过这个节点，连 diff 都不做
```

---

## 六、BuildContext 与树

### context 本质

```dart
Widget build(BuildContext context) { }
// context 就是当前 Widget 对应的 Element
// Element 知道自己在 Element Tree 上的位置
// = context 知道自己的位置
```

### of(context) 向上查找

```
根节点 MaterialApp（Theme 在这里）  ← 根节点方向（向上）
    │
  Scaffold
    │
  Column
    │
  Button  ← Theme.of(context) 从这里开始往根节点方向爬
```

`of(context)` 沿 Element Tree **向根节点方向**爬，找到第一个匹配类型的祖先节点返回（就近原则）。

向下查找不支持，也不应该——父节点不应该依赖子节点状态。

### 常见 of(context) 都是同一原理

```dart
Theme.of(context)         // 向上找 Theme
Navigator.of(context)     // 向上找 Navigator
MediaQuery.of(context)    // 向上找 MediaQuery
Provider.of<T>(context)   // 向上找 Provider<T>
Scaffold.of(context)      // 向上找 Scaffold
```

### 树结构的价值

```
数据流向：从上往下（父传子）↓
查找方向：从下往上（子找父）↑

树结构天然支持：
  - 就近原则（找最近的祖先）
  - 局部覆盖（嵌套 Theme、嵌套 Navigator）
```