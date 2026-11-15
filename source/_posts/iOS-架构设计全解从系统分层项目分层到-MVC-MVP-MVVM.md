---
title: iOS 架构设计全解：从系统分层、项目分层到 MVC / MVP / MVVM
date: 2026-11-15 13:30:00
tags: iOS, 架构设计
---

本文梳理 iOS 架构的几层含义、架构师设计项目分层的思路、三大 UI 模式（MVC、MVP、MVVM）的实现对比，以及对"架构师存在意义"的思考。

<!--more-->

### 一、先搞清楚：什么是"iOS 架构"

"iOS 架构"常见有两种含义，很多人会混淆。

#### 1. iOS 系统架构（操作系统本身）

苹果官方把 iOS 系统分为四层，从上到下是：

- **Cocoa Touch 层**：UIKit、SwiftUI、通知、手势、多任务，直接面向 App 开发
- **Media 层**：Core Graphics、Core Animation、AVFoundation、Metal 等图形音视频能力
- **Core Services 层**：Foundation、Core Data、CloudKit、URLSession、Core Location 等
- **Core OS 层**：内核（Darwin/XNU）、安全、驱动、底层网络和线程

#### 2. App 软件架构（日常所说的"iOS 架构"多指这个）

指开发者如何组织自己 App 的代码，包括：

- **UI 层设计模式**：MVC、MVVM、MVP、VIPER、Redux/TCA
- **分层架构**：表现层 → 业务/领域层 → 数据层，Clean Architecture、DDD 思想
- **工程层面**：模块化/组件化、依赖注入、路由/Coordinator、网络与持久化封装、日志埋点
- **质量保障**：可测试性设计、CI/CD、代码规范、性能与稳定性监控

> **MVVM 与分层是什么关系？** MVVM 是 UI 层的设计模式，分层是整体的结构划分，两者不冲突，通常搭配使用。例如：整体三层架构，表现层内部用 MVVM，数据层用 Repository 模式，再用模块化把不同业务拆开。

### 二、架构师如何设计项目分层

分层设计的核心是回答三个问题：**职责怎么切、依赖往哪指、变化被隔离在哪**。

#### 1. 典型的整体分层（由上到下）

```
┌─────────────────────────────┐
│  App 壳层（App Shell）        │  启动、生命周期、DI 组装、路由注册
├─────────────────────────────┤
│  业务模块层（Feature Modules）│  首页、订单、个人中心……各自独立
├─────────────────────────────┤
│  业务基础层（Business Base）  │  账号、支付、分享、统一弹窗等
├─────────────────────────────┤
│  基础服务层（Infrastructure） │  网络、存储、日志、埋点、图片、路由
├─────────────────────────────┤
│  工具/公共层（Foundation）    │  扩展、工具类、UI 组件库、设计规范
└─────────────────────────────┘
```

**依赖规则**：只允许上层依赖下层，同层之间不直接依赖，需要通信就通过协议或路由。

#### 2. 单个业务模块内部再分层

每个 Feature 内部通常采用 Clean Architecture 的简化版：

| 层 | 内容 | 依赖 |
|---|---|---|
| Presentation | View、ViewController、ViewModel | → Domain |
| Domain | Entity、UseCase、Repository 协议 | 不依赖任何层（最纯净）|
| Data | Repository 实现、网络 DTO、数据库、Mapper | → Domain（实现其协议）|

关键是**依赖倒置**：Domain 定义 Repository 协议，Data 层去实现，业务逻辑不关心数据来自网络还是缓存。

#### 3. 架构师要重点设计的六件事

1. **模块划分与边界**：按业务域拆，而不是按技术类型拆；每个模块用独立的 Swift Package 或 Framework，并拆出 Interface（对外协议）与 Implementation（内部实现），其他模块只依赖 Interface，避免循环依赖并加快编译。
2. **模块间通信**：页面跳转用路由或 Coordinator；服务调用用协议 + 服务注册中心；事件广播用 EventBus / Combine / NotificationCenter（要克制）。
3. **依赖注入**：在 App 壳层统一组装，业务层面向协议编程，以构造器注入为主，复杂场景可用 Swinject、Factory 等容器。
4. **网络与数据层**：封装请求构建、拦截器（鉴权、重试、日志）、统一错误模型、DTO 到 Domain Entity 的映射；缓存与数据库要抽象，保证可替换。
5. **UI 层规范**：选定一种模式（MVVM 最常见）并制定约定，例如 ViewModel 不引用 UIKit；沉淀统一的组件库和设计 Token。
6. **工程与质量体系**：多 Package 管理、二进制缓存、CI/CD、单测策略（Domain 层覆盖率要求最高）、SwiftLint、监控、Code Review 规则。

#### 4. 按项目规模裁剪

- **小项目 / 初创期**：MVVM + 简单三层（View / ViewModel / Service），不要过度设计
- **中型项目**：加上 Repository、DI、Coordinator，开始按功能拆 Package
- **大型多团队项目**：完整组件化 + 路由 + Interface/Impl 分离 + 二进制化 + 架构治理（依赖检查、循环依赖检测）

#### 5. 常见误区

- 为了分层而分层，一个简单功能写出七八个类
- 层与层之间用 Notification 或全局单例偷偷通信，破坏依赖规则
- 只拆了目录，没拆编译边界，模块之间依然互相引用
- 公共层不断膨胀，最后变成"垃圾桶"

### 三、MVC、MVP、MVVM 的实现

下面用同一个需求贯穿三种模式：**登录页**（输入账号密码，点击登录，成功跳转、失败提示）。

#### 1. MVC

- **Model**：数据和业务逻辑（用户模型、登录服务）
- **View**：界面展示（UIView、Storyboard、xib）
- **Controller**：协调者，接收用户操作、调用 Model、更新 View

由于 UIKit 中 ViewController 同时管理 View 的生命周期，View 和 Controller 实际上紧耦合。

```swift
// Model
struct User { let name: String }

final class AuthService {
    func login(account: String, password: String,
               completion: @escaping (Result<User, Error>) -> Void) {
        // 网络请求...
    }
}

// Controller（同时承担了 View 逻辑和业务协调）
final class LoginViewController: UIViewController {
    private let service = AuthService()

    @objc private func loginTapped() {
        guard let account = accountField.text, !account.isEmpty,
              let pwd = passwordField.text, pwd.count >= 6 else {
            showAlert("账号或密码格式不正确")
            return
        }
        loginButton.isEnabled = false
        service.login(account: account, password: pwd) { [weak self] result in
            DispatchQueue.main.async {
                self?.loginButton.isEnabled = true
                switch result {
                case .success: self?.navigateToHome()
                case .failure(let e): self?.showAlert(e.localizedDescription)
                }
            }
        }
    }
}
```

| 优点 | 缺点 |
|---|---|
| 简单直观，上手快 | Controller 臃肿（Massive View Controller）|
| 苹果官方支持，资料多 | 校验、格式化、状态管理堆在 VC 里，难以单测 |
| 小页面开发效率高 | View 和 Controller 耦合 |

#### 2. MVP

- **View**：ViewController + UIView，只负责展示和转发用户事件
- **Presenter**：持有业务和展示逻辑，通过协议操作 View，因此不依赖 UIKit，可脱离界面做单测

```
View ──(用户事件)──▶ Presenter ──▶ Model
View ◀──(协议方法)── Presenter
```

```swift
// View 协议：Presenter 只认识这个接口
protocol LoginView: AnyObject {
    func showLoading(_ show: Bool)
    func showError(_ message: String)
    func navigateToHome()
}

// Presenter：不 import UIKit
final class LoginPresenter {
    private weak var view: LoginView?
    private let service: AuthService

    init(view: LoginView, service: AuthService = AuthService()) {
        self.view = view
        self.service = service
    }

    func loginTapped(account: String?, password: String?) {
        guard let account, !account.isEmpty,
              let password, password.count >= 6 else {
            view?.showError("账号或密码格式不正确")
            return
        }
        view?.showLoading(true)
        service.login(account: account, password: password) { [weak self] result in
            DispatchQueue.main.async {
                self?.view?.showLoading(false)
                switch result {
                case .success: self?.view?.navigateToHome()
                case .failure(let e): self?.view?.showError(e.localizedDescription)
                }
            }
        }
    }
}

// View：只做展示 + 转发事件
final class LoginViewController: UIViewController, LoginView {
    private lazy var presenter = LoginPresenter(view: self)

    @objc private func loginTapped() {
        presenter.loginTapped(account: accountField.text,
                              password: passwordField.text)
    }
}
```

| 优点 | 缺点 |
|---|---|
| 逻辑与 UIKit 解耦，易于单测 | View 协议方法随页面复杂度膨胀 |
| 职责清晰，VC 变薄 | 协议 + Presenter，样板代码多 |
| 不依赖任何绑定框架 | 仍需手动同步状态 |

#### 3. MVVM

MVP 是 Presenter 主动调用 View；MVVM 是 View 被动订阅 ViewModel 的状态变化（数据绑定）。ViewModel 完全不知道 View 的存在，单向依赖更彻底。

```
View ──(调用方法/命令)──▶ ViewModel ──▶ Model
View ◀──(绑定/订阅状态)── ViewModel
```

**UIKit + Combine 版本**：

```swift
import Combine

final class LoginViewModel {
    @Published var account = ""
    @Published var password = ""
    @Published private(set) var isLoading = false
    @Published private(set) var errorMessage: String?
    let loginSucceeded = PassthroughSubject<Void, Never>()

    // 派生状态：按钮是否可点击
    var isLoginEnabled: AnyPublisher<Bool, Never> {
        Publishers.CombineLatest3($account, $password, $isLoading)
            .map { account, pwd, loading in
                !account.isEmpty && pwd.count >= 6 && !loading
            }
            .eraseToAnyPublisher()
    }

    private let service: AuthService
    init(service: AuthService = AuthService()) { self.service = service }

    func login() {
        isLoading = true
        service.login(account: account, password: password) { [weak self] result in
            DispatchQueue.main.async {
                self?.isLoading = false
                switch result {
                case .success: self?.loginSucceeded.send()
                case .failure(let e): self?.errorMessage = e.localizedDescription
                }
            }
        }
    }
}

// View：只做绑定
final class LoginViewController: UIViewController {
    private let viewModel = LoginViewModel()
    private var cancellables = Set<AnyCancellable>()

    private func bind() {
        viewModel.isLoginEnabled
            .receive(on: DispatchQueue.main)
            .sink { [weak self] in self?.loginButton.isEnabled = $0 }
            .store(in: &cancellables)

        viewModel.$errorMessage
            .compactMap { $0 }
            .sink { [weak self] in self?.showAlert($0) }
            .store(in: &cancellables)

        viewModel.loginSucceeded
            .sink { [weak self] in self?.navigateToHome() }
            .store(in: &cancellables)
    }
}
```

**SwiftUI 版本**（天然适配 MVVM）：

```swift
@MainActor
final class LoginViewModel: ObservableObject {
    @Published var account = ""
    @Published var password = ""
    @Published var isLoading = false
    @Published var errorMessage: String?

    var canLogin: Bool { !account.isEmpty && password.count >= 6 && !isLoading }
    func login() async { /* 调用 service，更新状态 */ }
}

struct LoginView: View {
    @StateObject private var vm = LoginViewModel()

    var body: some View {
        VStack {
            TextField("账号", text: $vm.account)
            SecureField("密码", text: $vm.password)
            Button("登录") { Task { await vm.login() } }
                .disabled(!vm.canLogin)
            if let msg = vm.errorMessage { Text(msg).foregroundColor(.red) }
        }
    }
}
```

| 优点 | 缺点 |
|---|---|
| ViewModel 不依赖 View，最易测试 | 需要绑定机制，有学习成本 |
| 状态驱动 UI，减少手动同步 | 简单页面会显得过度设计 |
| 与 SwiftUI 天然契合 | 绑定链过长时调试困难，ViewModel 也可能臃肿 |

#### 4. 三者对比

| 维度 | MVC | MVP | MVVM |
|---|---|---|---|
| 中间层 | Controller | Presenter | ViewModel |
| View 与中间层关系 | 紧耦合，Controller 持有 View | Presenter 持有 View 协议引用 | ViewModel 不持有 View，View 订阅 ViewModel |
| 更新 UI 的方式 | Controller 直接操作控件 | Presenter 调用 View 协议方法 | 数据绑定，状态变化自动刷新 |
| 可测试性 | 差 | 好 | 最好 |
| 样板代码 | 少 | 较多（协议）| 中等（依赖绑定框架）|
| 典型适用 | 小项目、原型 | 不想引入响应式框架的团队 | Combine / RxSwift / SwiftUI 项目 |

#### 5. 选型建议

- **页面简单、快速交付**：MVC 够用，但要把网络、校验等逻辑拆成独立类，不要全塞 VC
- **不想引入响应式框架，但要可测试**：MVP
- **使用 SwiftUI 或已有 Combine / RxSwift**：MVVM 是首选
- **页面状态复杂、需要严格可追溯**：可在 MVVM 基础上走向单向数据流（Redux / TCA）

> 注意：这三种模式只解决 UI 层怎么组织，真正支撑大型项目的是前面讲的**分层、模块化和依赖注入**，它们是搭配关系而不是替代关系。

### 四、架构师存在的意义

架构师的价值不在于画出漂亮的图，而在于让系统和团队在变化中仍能高效、稳定地前进。

1. **管理复杂度**：功能和人员增长会让代码关系呈指数级膨胀。通过分层、模块化、边界划分，让每个人只需理解系统的一小部分。好的架构让普通人也能写出不出错的代码，而不是依赖个别高手。
2. **为变化做准备，而不是预测未来**：区分稳定部分（业务规则、领域模型）与易变部分（UI 框架、网络库、第三方 SDK），把易变的隔离在稳定边界之外。只在真正有变化风险的地方付出抽象的成本。
3. **做取舍，并为取舍负责**：开发速度 vs 长期可维护性，灵活性 vs 简单性，统一规范 vs 团队自主。没有最好的架构，只有当前约束下最合适的架构。
4. **对齐团队，降低协作成本**：统一术语和约定，明确模块边界让团队并行开发，沉淀基础设施避免重复造轮子。很多架构问题其实是组织问题的映射（康威定律）。
5. **守护长期质量**：项目腐化是缓慢发生的，一个临时的全局单例、一次"先跳过分层"的捷径，积累起来就是技术债。要用依赖检查、循环依赖检测、Lint 规则等自动化手段约束，并持续重构。

**需要警惕的几点**

- 架构师不应只做设计、不写代码。脱离一线的架构容易变成空中楼阁，最好的架构师仍深度参与代码与 Code Review。
- 架构不是越复杂越好。五人小团队套上完整组件化 + 路由 + 多层抽象，是在为简历服务而不是为项目服务。能用简单方案解决的问题，就不该引入复杂方案。
- 架构师不是决策的垄断者。让团队参与讨论，用 ADR（架构决策记录）记录背景，方案更容易被执行。

> 架构师存在的意义，是在不确定的环境中，帮团队做出可解释、可演进、成本可控的技术决策，让系统的复杂度增长慢于业务的增长。
> **架构是一种责任，而不一定是一个头衔。**

### 总结

- "iOS 架构"分系统架构和 App 架构两层含义，日常讨论多指后者
- MVC / MVP / MVVM 解决 UI 层组织问题，分层、模块化、依赖注入解决整体结构问题，二者是搭配关系
- 分层设计的核心是：职责清晰、依赖单向、变化隔离
- 架构要匹配项目规模，克制过度设计
- 架构师的价值在于管理复杂度、做可解释的取舍，并持续守护系统质量
