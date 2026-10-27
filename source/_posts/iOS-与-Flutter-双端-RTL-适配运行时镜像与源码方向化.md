---
title: iOS 与 Flutter 双端 RTL 适配：运行时镜像与源码方向化
date: 2026-10-27 11:30:00
tags: iOS、Flutter、RTL、阿拉伯语、Runtime
---

## 背景

UMU 要出海，阿拉伯语（`ar-AE`）和希伯来语（`he-IL`）这两门从右往左的语言绕不过去。

难点不在「翻不翻」，而在两端是**两套完全不同的 runtime**：

- 原生这侧是 UIKit + Masonry，页面存量大、历史包袱重，逐页去改约束不现实；
- Flutter 这侧是声明式布局，框架自带方向化 API，但历史代码里几乎全是 `EdgeInsets.only(left:)` 这种绝对方向写法。

最后两端走的是**方向相反的两条路**：iOS 用运行时镜像——整体翻转、局部抵消；Flutter 用源码级迁移——把绝对方向改成方向化 API。这篇把两边拆开讲，再说为什么必须相反，以及这么做的代价。

> 补一句归属：iOS 侧这套框架（`UMURTL`）是字节开源库 **AWERTL** 的移植版，每个源文件头都挂着 `Refer: https://github.com/bytedance/AWERTL`。原仓库 2019 年就归档了（MIT 协议），核心机制基本一致，只做了前缀改名和业务层补全。

## 一、先分清两件事：文字方向与布局方向

RTL 里最容易搞混的是两个完全独立的东西：

| | 管什么 | iOS | Flutter |
|---|---|---|---|
| **文字方向** | 字形、阅读顺序、标点位置 | `semanticContentAttribute` + 系统 bidi 排版 | `TextDirection` / `Directionality` |
| **布局方向** | 视图的左右顺序、边距在哪一侧 | 镜像翻转（transform）或语义约束 | `start`/`end` 方向化 API |

一句话：**文字方向是「字怎么排」，布局方向是「块怎么摆」。** 只做其中一个，效果一定是半拉子——比如布局翻过去了但文字还左对齐，或者文字对了但返回箭头还在左边。

UMU 的选择是：**布局方向靠镜像/方向化 API 自己算，文字方向只保留「阅读语义」这一层**，并且主动把系统的自动布局镜像关掉——原因在第四节。

## 二、iOS：运行时镜像

### 2.1 为什么不逐页改

最直观的做法是：把每个页面的 `mas_left` 改成 `mas_leading`、`NSTextAlignmentLeft` 改成 `NSTextAlignmentNatural`，让系统自动镜像。

现实是：页面多、约束杂、还有一堆手写 frame 和老代码，改完没人敢保证回归覆盖全。运行时方案的价值就在这——**不改业务代码，在窗口这一层统一处理**。

### 2.2 是镜像，不是旋转

整个方案的地基是一句话：给 `UIWindow` 的 layer 打一个 `scale(-1, 1)`。

```objc
self.layer.umurtl_basicTransform = CGAffineTransformMakeScale(-1, 1);
```

注意是**水平镜像**，不是 180° 旋转。旋转会把上下也倒过来，而且语义上不是「左右互换」；镜像才是真正意义上的左右对调。

打完这一下，window 里的所有东西都左右反了——**布局对了**，但**文字和图片也反了**（镜头里的字是镜像的）。所以接下来全是「抵消」的活。

### 2.3 异或：谁该抵消，谁该跟随

抵消逻辑是整个框架的核心，就三行：

```objc
// UIView+UMURTL.m
BOOL shouldFlipCurrentView   = updatedViewType == UMURTLViewTypeFlip || updatedViewType == UMURTLViewTypeFlipWithAllDescendants;
BOOL shouldFlipSuperview     = superViewCalculatedViewType == UMURTLViewTypeFlip || superViewCalculatedViewType == UMURTLViewTypeFlipWithAllDescendants;
BOOL shouldSetFlipTransform  = shouldFlipSuperview ^ shouldFlipCurrentView;   // 异或
```

翻译成人话：

- 父层翻了、自己**也**要翻 → `1 ^ 1 = 0` → 再翻一次等于白翻，**不加 transform**（跟随父层镜像）；
- 父层翻了、自己**不**要翻 → `1 ^ 0 = 1` → **自己再翻一次**，把父层的镜像抵消掉；
- 父层没翻 → 加不加都一样，保持原状。

所以「抵消」这个动作，在代码里的表现是**主动再写一次 `scale(-1,1)`**，而不是「什么都不做」。这一点很容易想反。

### 2.4 三种视图类型

每个视图最终会被归成六种类型之一，常用的就三类：

| 类型 | 含义 |
|---|---|
| `Inherit` | 跟随父层（默认行为，有父视图时自动用它） |
| `Normal` | 我永远保持正立——**即参与抵消** |
| `Flip` | 我永远要翻（方向性图标等） |
| `Normal/FlipWithAllDescendants` | 连整棵子树一起定死 |

优先级是：**显式设置的 `umurtl_viewType` > 类白名单 > 默认 `Inherit`**。

Window 自己是 `Flip`，但有三类窗口例外：

```objc
- (UMURTLViewType)umurtl_automaticViewType
{
    if ([self isKindOfClass:NSClassFromString(@"UIRemoteKeyboardWindow")]) return UMURTLViewTypeNormal;
    if ([self isKindOfClass:NSClassFromString(@"UIStatusBarWindow")])    return UMURTLViewTypeNormal;
    if ([self isKindOfClass:NSClassFromString(@"UITextEffectsWindow")])   return UMURTLViewTypeNormal;
    return UMURTLViewTypeFlip;
}
```

键盘、状态栏、文字特效窗口不参与镜像，否则会出现键盘左右颠倒这类诡异问题。

### 2.5 弱引用注册表

切语言时要能把所有已经存在的视图重新算一遍 transform，就得有个地方记着它们。这里用的是 `NSPointerArray` 的弱引用：

```objc
manager.registeredUIElements = [NSPointerArray pointerArrayWithOptions:NSPointerFunctionsWeakMemory];
```

视图在 `didMoveToWindow` 时自动注册：

```objc
- (void)umurtl_didMoveToWindow
{
    [self umurtl_didMoveToWindow];
    [self umurtl_renewLayerTransformForceRecursively:NO];
    [[UMURTLManager sharedInstance] registerUIElement:self];
}
```

弱引用的意义是**不会因为注册表而多持有视图**，视图销毁后指针自动置空，不需要手动反注册。代价是数组只增不减（见第六节）。

### 2.6 切语言时做了什么

切语言（`changeLanguage:`）走的是同一调用栈里的同步动作：

```objc
- (void)setEnableRTL:(BOOL)enableRTL
{
    if (enableRTL == _enableRTL) return;
    _enableRTL = enableRTL;

    NSMutableSet<UIView *> *rootViews = [NSMutableSet set];
    for (每个注册过的视图) {
        [element umurtl_performReload];          // 触发挂着的重算 block（如文字对齐）
        [rootViews addObject:[self rootViewForView:element]];  // 归并到根节点
    }
    [rootViews enumerateObjectsUsingBlock:^(UIView *obj, BOOL *stop) {
        [obj umurtl_renewLayerTransformForceRecursively:YES];  // 每个根只递归一次
    }];
}
```

两个细节值得说：

1. **先归并到根节点再递归**。注册表里成千上万个视图，如果每个都从自己往下递归一遍，复杂度会炸；归并成若干个 window 之后，每个 window 只走一次整树遍历。
2. **没有跨进程消息，也没有 rebuild**。就是同步改了一堆 CALayer 的 `transform`，Core Animation 重新合成图层而已。这跟 Flutter 侧的机制完全不同（见 3.5）。

另外这里还顺手把系统的文字语义方向设上了：

```objc
[UIView appearance].semanticContentAttribute      = UISemanticContentAttributeForceLeftToRight;
[UISearchBar appearance].semanticContentAttribute = UISemanticContentAttributeForceLeftToRight;
[UILabel appearance].semanticContentAttribute     = attr;  // 文字类控件按语言设 RTL/LTR
```

`UIView` 全局强制 LTR，是为了**关掉系统的自动布局镜像**——因为布局方向我们自己用 transform 处理了，系统再插手一次就是双重翻转。但 `UILabel`/`UITextField`/`UITextView` 这类要保留 RTL，否则阿拉伯文的阅读顺序和标点会不对。

### 2.7 transform 怎么写进 CALayer

业务代码可能自己也在用 `transform`（缩放、动画）。如果直接覆盖 `layer.affineTransform`，业务动画就没了。所以这里 swizzle 掉 `setAffineTransform:`，把「镜像变换」和「业务变换」做一次拼接：

```objc
- (void)umurtl_setAffineTransform:(CGAffineTransform)m
{
    objc_setAssociatedObject(self, @selector(umurtl_affineTransform), [NSValue valueWithCGAffineTransform:m], OBJC_ASSOCIATION_RETAIN_NONATOMIC);
    [self umurtl_setAffineTransform:CGAffineTransformConcat(self.umurtl_basicTransform, m)];
}
```

原本的变换被单独存起来，读的时候返回 `umurtl_affineTransform` 而不是拼接后的结果——业务侧读到的还是它自己设的那个值。

除了这个，`CALayer` 上还 swizzle 了三处：

- `addAnimation:forKey:` —— 遇到 `transform.scale` 动画，把 `fromValue`/`toValue` 取反，保证动画方向和镜像一致；
- `renderInContext:` —— 离屏渲染（截图、生成图片）时补一次 CTM 翻转，否则截出来的图是反的；
- `UIView` 的 `snapshotViewAfterScreenUpdates:` —— 转场快照会把新视图的 `umurtl_viewType` 一起带过去，**避免转场时被二次翻转**。

### 2.8 两个白名单（语义正好相反）

这里有两个东西都叫「白名单」，但意思完全相反，很容易记混：

**① `noFlipWhiteListClasses`——不翻名单（抵消名单），20 个类**

```objc
NSArray<NSString *> *noFlipWhiteListClasses = @[@"UILabel", @"UITextView", @"UITextField",
                                                @"UIWebView", @"WKWebView", @"UIImageView",
                                                @"UISearchBar", @"UITableViewIndex", @"YYLabel",
                                                @"TTTAttributedLabel", @"TYAttributedLabel",
                                                @"LOTAnimationView", ...];
```

进这个名单的类，会被注入 `umurtl_automaticViewType` 返回 `UMURTLViewTypeNormal`——**主动抵消窗口的镜像，让文字/图片正立**。

反过来说：**一个 `UILabel` 如果不在这份名单里，它在 window 镜像是 RTL 的状态下会跟着父层一起翻，文字就是左右颠倒的。** 这就是为什么名单要维护。

名单里也能标「要翻」和「连子树一起」——元素加前缀 `!` 表示 `Flip`，加后缀 `!` 表示继承给整棵子树；现在的名单里没有用到这两种标记。

**② `flipImageNames`——要翻名单，近 50 项**

针对**方向性图片**：返回箭头、展开箭头、进度箭头……这些在 RTL 下必须左右调头。做法是在 `UIImageView` 的 `setImage:` 里判断图片名：

```objc
- (void)umurtl_setImage:(UIImage *)image
{
    self.umurtl_viewType = [self shouldFlipImage:image] ? UMURTLViewTypeFlip : UMURTLViewTypeAuto;
    [self umurtl_setImage:image];
}
```

图片来源有两条：图片名通过 `UIImage+UMURTL` 在 `imageNamed:` 时存进关联对象，以及系统自带的 `flipsForRightToLeftLayoutDirection`（系统标记过的方向图）。名单内容大致是：**22 张箭头图 + 25 个 iconfont 图标 + 2 张业务图**（`group_pinned_icon`、`u_score_background`）。

> 顺带一提：`UMUIconFontItemExercise` 在这个数组里出现了两次，无实际影响，属于历史遗留。

**为什么 `UIImageView` 同时出现在两份名单里？** 因为优先级是「显式 `umurtl_viewType` > 类白名单」。`setImage:` 里显式设了 `Flip` 的，覆盖掉类白名单的 `Normal`——所以同一个 `UIImageView` 类，普通照片保持正立，返回箭头翻过去。

### 2.9 文字对齐管线

`transform` 只解决「字形颠倒」，不解决**对齐方向**。一个左对齐的 `UILabel`，镜像之后视觉上变成右对齐——这刚好是我们想要的，但前提是它得先被设成左对齐。

所以 `UILabel` 的 `initWithFrame:`/`initWithCoder:` 里直接强制：

```objc
self.textAlignment = NSTextAlignmentLeft;
```

物理左对齐 + 镜像 = 视觉右对齐，正好是 RTL 的起始侧。

而在切语言时，`setTextAlignment:` 被 swizzle 过，改动被塞进 reload block，等语言切换时统一重算：

```objc
- (void)umurtl_setTextAlignment:(NSTextAlignment)textAlignment
{
    @weakify(self);
    [self umurtl_addReloadBlockForKey:@"alignment" andExecuteIt:^{
        @strongify(self);
        if ([UMURTLManager sharedInstance].enableRTL && [self shouldUseFlippedTextAlignment]) {
            if (textAlignment == NSTextAlignmentCenter)      { /* center 不变 */ }
            else if (textAlignment == NSTextAlignmentRight)  { [self umurtl_setTextAlignment:NSTextAlignmentLeft]; }
            else                                             { [self umurtl_setTextAlignment:NSTextAlignmentRight]; }
        } else {
            [self umurtl_setTextAlignment:textAlignment];
        }
    }];
}
```

简单说就是 **Left 与 Right 对调，Center 不动**。

reload block 用的是「按 key 存一个 block」的字典，同一个 key 反复设置只保留最后一个，切语言时统一执行一遍（`umurtl_performReload`）。这也是为什么 2.6 里遍历注册表时要先 `umurtl_performReload`。

两个例外被排除在翻转之外：`UITextFieldLabel`（`UITextField` 内部自己的 label，对齐由外层管）和 `UIDatePickerContentView` 里的 label。

### 2.10 Masonry 降级

我们全站的约束大量用了 `mas_leading`/`mas_trailing`。这两个在开启系统的 RTL 语义后会**自动镜像**，而我们已经在 window 上镜像了一次——两边叠加就是**双重翻转**，布局会翻回原位。

处理办法不是改业务代码，而是运行时把语义方向「降级」成物理方向：

```objc
+ (void)load
{
    [self swizzleClass:@"MASConstraintMaker" oldMethod:@"leading"  withNewMethod:@"left"];
    [self swizzleClass:@"MASConstraintMaker" oldMethod:@"trailing" withNewMethod:@"right"];
    [self swizzleClass:@"MASViewConstraint"  oldMethod:@"leading"  withNewMethod:@"left"];
    [self swizzleClass:@"UIView"             oldMethod:@"mas_leading" withNewMethod:@"mas_left"];
    // ... trailing / mas_trailing / mas_leadingMargin / mas_trailingMargin
}
```

实现手段是 `method_setImplementation`——**直接把 `leading` 的实现指向 `left`**，不是 `method_exchangeImplementations`。因为 `leading` 这个方法本身可能只存在于分类上，直接改实现更稳。

一句话：**`leading` 不再是「阅读起始侧」，而是「屏幕物理左边」**。方向全靠 transform 那一层统一翻，Masonry 层面保持纯粹的左右。

### 2.11 容易漏的点

这些都是实际踩过的：

- **文字控件不在名单里** → 文字颠倒（2.8）；
- **方向性图片不在 `flipImageNames` 里** → 箭头指错方向；
- **`UIButton`** —— 系统没有帮它做文字抵消，需要额外补一个分类；
- **富文本**（`NSAttributedString`）里手写的段落样式不跟随，`setAttributedText:` 里要把 `Natural` 兜底成 `Left`；
- **转场截图** —— 不 swizzle `snapshotViewAfterScreenUpdates:` 会出现二次翻转的闪帧；
- **`UIWebView`/`WKWebView`** —— 内部的 `Directionality` 由 H5 自己管，原生这层只能保证容器不翻。

## 三、Flutter：源码级方向化

### 3.1 框架给了什么

Flutter 的 RTL 是**框架机制 + 我们做源码迁移**，不是「打开开关就全自动」。链路是这样：

1. `MaterialApp` 的 `locale` 解析到 `ar`/`he`；
2. `GlobalWidgetsLocalizations.delegate` 在树顶注入 `Directionality(textDirection: TextDirection.rtl)`；
3. 所有方向化 API 在 **layout 阶段**从最近的 `Directionality` 取值，落成真实的像素。

关键在于第 3 步：`EdgeInsetsDirectional.only(start: 12)` 里存的**就是 `start` 这个抽象值**，它必须被 `resolve(textDirection)` 之后才知道是左 12 还是右 12。所以「方向化 API 会自动处理 RTL」的真正含义是——**它把「往哪边」这个决定推迟到 layout**，前提是上方确实有 `Directionality`。

**绝对方向 API 一律不会被自动处理**：`EdgeInsets.only(left:)`、`BorderRadius.only(topLeft:)`、`TextAlign.left`、`Alignment.centerLeft`、`Positioned(left:)`、`Transform.translate(Offset(-x, 0))`、CustomPainter 里的坐标——框架不管，写死就是写死。

### 3.2 两个迁移脚本

历史代码里全是绝对方向写法，人工改不现实，所以写了两支一次性脚本（`common/umu_i18n/tools/RTL/`）。

**`replace_edgeinsets.py`**

```python
rules = [
  (r'EdgeInsets\.fromLTRB\((\S+),\s+(\S+),\s+(\S+),\s+(\S+)\)', r'EdgeInsetsDirectional.fromSTEB(\1, \2, \3, \4)'),
  (r'EdgeInsets\.all\((\S+)\)',      r'EdgeInsetsDirectional.all(\1)'),
  (r'EdgeInsets\.zero',                r'EdgeInsetsDirectional.zero'),
  (r'EdgeInsets\?',                     r'EdgeInsetsGeometry?'),   # 类型声明必须一起改
  (r'EdgeInsets ',                      r'EdgeInsetsGeometry '),
  (r'List\<EdgeInsets\>',               r'List<EdgeInsetsGeometry>'),
  (r'EdgeInsets\.only\(...\)',         convert_edges_only),       # left/right -> start/end
]
param_mapping = {'top': 'top', 'left': 'start', 'bottom': 'bottom', 'right': 'end'}
```

**`replace_border_radius.py`**

```python
param_mapping = {
  'BorderRadius': 'BorderRadiusDirectional',
  'left': 'start',  'right': 'end',
  'topLeft': 'topStart',      'topRight': 'topEnd',
  'bottomLeft': 'bottomStart','bottomRight': 'bottomEnd',
}
```

两个容易忽略的点：

- **类型声明要一起改**。`EdgeInsets` 是具体类，`EdgeInsetsDirectional` 和它共同继承 `EdgeInsetsGeometry`，所以形参/泛型声明写成 `EdgeInsetsGeometry` 才不会编译报错——规则里的 `EdgeInsets?` → `EdgeInsetsGeometry?` 就是干这个的。
- **脚本只覆盖这两类 API**。广度就到这。

### 3.3 图标的 `matchTextDirection`

图片要拆成**两个维度**看：

- **内容朝向** —— 由 `Image` 的 `matchTextDirection` 决定，默认 `false`（不翻）。对普通照片来说这个默认值是对的：**照片不该被镜像**；
- **所在位置** —— 由布局决定，RTL 下自动换到另一边。

只有方向性图标（返回箭头、展开箭头）才需要把内容也翻过去。这部分由 `iconfont.py` 生成 `IconData(codePoint, matchTextDirection: ...)`，再通过 `UmuIcon` 透传给 `Icon`。

`iconfont.py` 里有个细节：`make_icon` 会去**旧的 `icon_font.dart` 里找同名行，继承它的 `matchTextDirection`**。这样人工标注一次之后，图标重新生成不会把标注冲掉。

翻一下全仓：**299 处图片里只有 20 来个文件开了 `matchTextDirection`**——也就是说绝大多数图片保持不翻，这正是预期的。

### 3.4 自动的边界在哪

一句口诀：**位置由框架算的自动，坐标由你自己算的不自动。**

| 层 | 例子 | 是否自动 |
|---|---|---|
| 框架内建组件 | `AppBar` 的 leading/actions、`Drawer`、`FloatingActionButton`、`ListTile`、`SnackBar`、`Icons.arrow_back` | ✅ 自动 |
| 方向化 API | `EdgeInsetsDirectional`、`BorderRadiusDirectional`、`AlignmentDirectional` | ✅ 自动（layout 时 resolve） |
| 绝对方向写法 | `TextAlign.left`、`EdgeInsets.only(left:)`、`Positioned(left:)`、`Alignment.centerLeft` | ❌ 不自动 |
| 手写坐标 | `Transform.translate`、`CustomPainter`、`OverlayEntry`、自定义 RenderObject | ❌ 不自动，需 `Directionality.of(context)` 自己判 |

### 3.5 切语言为什么 `setState` 就够

原生切完语言，通过 EventChannel 发一条 `onEnvChange` 给 Flutter：

```objc
[FLTEngine.messenger sendEventData:@{kFlutterMessengerEvent : @"onEnvChange",
                                     kFlutterMessengerData  : getUserEnvDict}];
```

Dart 侧只有**一个**订阅者（`Event` 单例），收到之后：

```dart
Event().listenEnvChanged((Object args) {
  if (args is Map) {
    AppLanguage lang = AppLanguage.current;      // 存旧值
    AppData.setEnv(env);                         // 内部改 AppLanguage.current
    if (lang != AppLanguage.current) {           // 变了才动
      _localeChange(AppLanguage.currentLocale);
    }
  }
});
```

`_localeChange` 就是顶层 `State` 里的一个 `setState`：`_locale` 改掉 → `MaterialApp.locale` 变 → 树顶重新注入 `Directionality` → **所有依赖过它的 element 被标脏，自顶向下 rebuild**。

这里的关键是 **`Directionality` 是个 `InheritedWidget`**。凡是 build 里调过 `Directionality.of(context)` 的 element 都会被登记进依赖表，值一变全部标脏。所以不需要「逐页通知」，一次 setState 就够。

几个实现细节：

- **幂等判断**：`if (lang != current)`，避免每次环境同步都白 rebuild 一次；
- **`_localeChange` 是个全局函数变量**：因为顶层 `main()` 没有 `State` 上下文，拿不到 `setState`，只能在 `initState` 里赋值；
- **是 rebuild，不是重绘**：widget 树重建 + layout + paint，成本比 iOS 那套改 CALayer 高；但 Element 复用、`State` 不重建，所以滚动位置、输入框内容、页面栈都不会丢；
- **`setState` 不会重跑 `initState`**：凡是把文案缓存在 `initState` 里的地方，切语言后不会更新——这类逻辑必须挪到 `build` 里或者加监听。

## 四、两端共存：为什么必须走相反的路

到这一步，两边的做法放在一起就有点吓人：

- **Flutter 侧是真的把布局换方向了**（`start` 在 RTL 下解析到右边）；
- **iOS 侧是给 window 打了个镜像**。

如果一个 Flutter 页面嵌在原生页面里，那这个 Flutter 容器**既会被 window 镜像翻一次，内部又已经按 RTL 摆好了**——叠加起来就是双重翻转，布局会诡异地「翻回去」，同时文字被镜像。

解决办法是一行：

```objc
- (void)alpFlutter_viewDidLoad
{
    [self alpFlutter_viewDidLoad];
    self.view.umurtl_viewType = UMURTLViewTypeNormalWithAllDescendants;
}
```

`NormalWithAllDescendants` 的意思是：**这棵子树整体不参与原生镜像**。Flutter 内容按自己算好的 RTL 正常显示。

这也是为什么开头说两端走的是**方向相反**的路：

| | iOS | Flutter |
|---|---|---|
| 布局方向怎么来的 | 运行时镜像翻转 | 源码级方向化 + 框架 resolve |
| 对 `leading`/`left` 的处理 | **降级**成物理左右（禁用自动翻） | **升格**成 `start`/`end`（启用自动翻） |
| 切语言怎么生效 | 同一调用栈改 CALayer transform | EventChannel + `setState` + `InheritedWidget` 传播 |
| 交给对方的边界 | 排除 Flutter 容器 | 无感知（由原生排除） |

方向虽然相反，但落到「同一个屏幕上不叠加」这个目标上是自洽的：**原生那侧只有一次镜像来源（window），Flutter 那侧只有一次方向来源（Directionality）。**

## 五、Flutter 侧的遗留欠账

迁移脚本只覆盖了 `EdgeInsets` 和 `BorderRadius`，所以还有一批绝对方向写法留在代码里，需要人工过：

- `TextAlign.left` / `Alignment.centerLeft` 这类对齐方向；
- `Positioned(left:)` 这类绝对定位；
- 个别 `Transform.translate` 和手写坐标。

这些框架都不会报错，lint 也拦不住，只能靠 review 和截图比对。这部分是**已知的、还没还完的账**。

## 六、取舍

这套方案不是银弹，几处代价是明确交换来的。

**1. 用「放弃原生语义布局」换「全局低风险」**
iOS 侧把 `UIView.appearance.semanticContentAttribute` 全局强制成 `ForceLeftToRight`，等于主动关掉了系统自带的 RTL 自动布局——因为系统那套和 window 镜像叠加会双重翻转。代价是：以后凡是「靠系统自动镜像」就免费的写法，在这套体系里都得显式处理。

**2. 用「语义丢失」换「一次搞定」**
`mas_leading`/`mas_trailing` 被 swizzle 成 `mas_left`/`mas_right`，`leading` 不再是「阅读起始侧」，而是「屏幕物理左边」。好处是一次性消除双重翻转；代价是**语义变了**——以后想恢复「语义方向」的能力，得先把这批降级撤掉。

**3. 用「长期维护白名单」换「不改业务代码」**
新增一个方向性图标要在 `flipImageNames` 登记，新增一个需要抵消的类要在 `noFlipWhiteListClasses` 登记。**漏登记不会报错，只会静默地多翻或漏翻一次**，这类问题只能靠截图比对发现。

**4. 脚本是一次性工具，不是长期护栏**
`replace_edgeinsets.py` / `replace_border_radius.py` 只管两类 API，覆盖范围外的得人工过；而且它们跑完就归档了，流水线里**没有**一个「禁止新增绝对方向写法」的检查。也就是说，欠账还会继续产生。

**5. 两端协同只有一个交界面，且很脆**
iOS 的镜像和 Flutter 的方向化互相不知道对方存在，唯一的交界面就是 Flutter 容器那一行 `NormalWithAllDescendants`。以后任何新的混合容器（RN、其它自渲染方案）接进来，都得补一条同样的排除，否则立刻双重翻转。

**6. 注册表只增不减**
弱引用数组避免了多持有视图，但指针本身不会回收（置空而非移除）。切语言时靠「先归并到根节点」来控制递归量，属于用一次归并换掉了遍历成本。

**7. Flutter 侧没有静态护栏**
「绝对方向 API 一律不自动翻」这件事，框架不报错、lint 拦不住，完全依赖 review。换来的是不用重写布局代码。

说到底，这套方案的核心交换是：

> **用「一次性的运行时手段」换掉「海量页面的重复改造」，用「长期维护白名单 + 人工 review」换掉「重写布局代码」。**

在页面存量大、出海时间紧的场景下这笔账是划算的；但如果是一个从零起的新项目，一开始就按方向化 API 写，显然更干净。

## 七、小结

- **iOS**：在 window 上打一次水平镜像，用「异或」决定每个视图是抵消还是跟随；白名单负责告诉框架「哪些类要正立」「哪些图要调头」；Masonry 语义方向降级为物理方向，避免和镜像叠加。切语言是同步改 CALayer transform，代价轻。
- **Flutter**：靠 `Directionality` 注入 + 方向化 API 的「延迟决策」；历史代码用两支脚本批量迁移；图标用 `matchTextDirection` 单独标注。切语言是 `setState` + `InheritedWidget` 依赖传播的整树 rebuild，代价重但状态不丢。
- **两端共存**：布局方向上必须只有**一个**来源。所以 iOS 把 Flutter 容器整棵子树排除掉镜像，这是两端唯一的交界面。
- **最大的两个坑**：一是「抵消」在代码里表现为主动再翻一次，容易想反；二是双重翻转——只要原生镜像和 Flutter 方向化在同一棵树上生效，立刻出问题。
