---
title: Apple IAP 内购完整流程（SK1 / SK2 对比 + 异常场景）
date: 2026-11-12 11:42:39
tags: 
---

# Apple IAP 内购完整流程（SK1 / SK2 对比 + 异常场景）

> 本文梳理 Apple 内购的完整闭环：App Store Connect 后台配置、客户端与服务端流程、StoreKit 1 与 StoreKit 2 的核心差异，以及常见异常与漏单场景的处理方式。
> 读者对象：iOS / Flutter 移动端开发与后端开发，希望理解苹果内购闭环与漏单根源。

## 目录

1. 前置说明
2. App Store Connect 后台配置步骤
3. 整体支付链路总览
4. SK1（StoreKit 1）完整流程
5. SK2（StoreKit 2）完整流程
6. SK1 与 SK2 核心差异（重点：漏单那一块）
7. 服务端统一职责与验签逻辑
8. 强制业务规则
9. 常见异常场景 + 处理方案
10. 小结

---

## 1. 前置说明

苹果内购分 3 种商品类型，创建商品时选定，一旦创建不能改类型：

- **消耗型 Consumable**：买一次用一次（金币、次数、道具），用完可以重复购买
- **非消耗型 Non-consumable**：一次购买永久拥有（解锁功能、去广告），不能重复买
- **自动续期订阅 Auto-renewable Subscription**：按月 / 按年自动续费，有过期、退款、恢复订阅逻辑

> 核心原则：**苹果只负责扣款和订单签名；权益发放、订单幂等、防漏单全部由我们自己业务侧保证**。

---

## 2. App Store Connect 后台配置

1. 进入 App Store Connect → 找到你的 App → **In-App Purchases**
2. 点「+」新建内购商品
3. 填写：
   - Product ID：**全局唯一**，一个商品一个 ID，客户端、服务端都靠它区分商品
   - 商品类型：消耗 / 非消耗 / 自动续期订阅
   - 价格档位（选择苹果定价表）
   - 本地化名称、描述（App Store 展示给用户看）
4. 提交审核前需要：上传审核截图、设置审核账号（沙盒测试账号）
5. 【SK2 可选增强】开启 **App Store Server Notifications V2**
   - 填写你的服务端 HTTPS 回调地址
   - 苹果订单状态变更（扣款、退款、订阅过期）会主动 POST 通知你的服务端
   - 仅做辅助，**不能替代客户端上报主链路**

> 注意：Product ID 一旦创建，删除后不能复用。

---

## 3. 整体支付链路总览（SK1 / SK2 通用骨架）

```
用户点击购买按钮
    ↓
客户端向苹果SDK请求商品信息（价格、名称）
    ↓
拉起苹果支付弹窗，用户输入Apple ID密码/面容确认支付
    ↓
苹果扣款成功 → 苹果生成订单（receipt / JWS）
    ↓
SDK回调交易对象，拿到凭证（receipt 或者 SK2 JWS）
    ↓
【客户端】把凭证传给后端
    ↓
【服务端】向苹果服务器验签，校验订单真实性
    ↓
验签通过 → 服务端幂等判断，给用户发放权益，落库
    ↓
服务端返回成功给客户端
    ↓
客户端调用 finishTransaction / transaction.finish() 标记这笔交易完结
    ↓
苹果SDK清除这笔待处理交易
```

> 红线：**必须等后端返回权益发放成功，才调用 finish！**
> 提前 finish = 苹果认为这笔交易结束，后续 SDK 不会再给你推这笔订单，极易漏单。

---

## 4. SK1（StoreKit 1）完整流程

### 客户端

1. 启动时添加 `SKPaymentQueue.default().add(observer)` 支付队列观察者（全局常驻）
2. 拉取商品：`SKProductsRequest` 传入 productId 数组，拿到 `SKProduct`，渲染购买页
3. 用户点击购买：构造 `SKPayment`，加入支付队列 `SKPaymentQueue.default().add(payment)`
4. 支付成功，观察者回调拿到 `SKTransaction`
5. 从 app 沙盒读取 receipt 凭证（`Bundle.main.appStoreReceiptURL`），把 receipt 传给后端
6. 等待后端返回成功 → 调用 `SKPaymentQueue.default().finishTransaction(transaction)`
7. 失败 / 网络异常：**不 finish**，这笔交易留在本地沙盒
   - 下次 App 启动，观察者会再次收到这笔未 finish 的交易
   - ⚠️ 致命短板：交易 “待办标记” 存在 App 沙盒；**卸载 App 重装，沙盒清空，本地再也收不到这笔交易**

### SK1 凭证

- 凭证是 receipt（base64 字符串）
- 后端拿到 receipt，调用苹果验签接口，返回订单明细

---

## 5. SK2（StoreKit 2）完整流程（Swift Concurrency async/await）

SK2 是 Swift 原生并发 API，不再依赖 delegate 观察者。

### 客户端

1. 全局监听交易流：`for await transaction in Transaction.updates`，App 启动就开启监听
2. 【兜底】启动时主动拉 `Transaction.all`：从苹果服务端拉取该 Apple ID 下所有**未 finish 的交易**
> 重点：这个是从苹果服务器拉，不是本地沙盒
3. 用户购买：`try await product.purchase()`，返回 `PurchaseResult`
4. 拿到成功的 `Transaction`，取出 `jwsRepresentation`（JWS 字符串）传给后端
5. 等待后端返回成功 → `await transaction.finish()`
6. 网络异常、后端报错：**不 finish**
> 这笔交易保存在苹果服务端；卸载重装、换同 Apple ID 设备，下次启动 `Transaction.all` 依然能拿到

### SK2 凭证

- 凭证是 JWS（JSON Web Signature），自带苹果签名，后端可以直接验签，也可以调用苹果接口校验

> 代码示意（极简版）

```swift
import StoreKit

Task {
    // 全局监听新交易
    for await transaction in Transaction.updates {
        let jws = transaction.jwsRepresentation
        let backendSuccess = await uploadJwsToServer(jws: jws)
        if backendSuccess {
            await transaction.finish()
        }
    }
}

// 启动兜底：拉苹果服务端所有未完结交易
func loadUnfinishedTransactions() async {
    for await transaction in Transaction.all {
        let jws = transaction.jwsRepresentation
        let backendSuccess = await uploadJwsToServer(jws: jws)
        if backendSuccess {
            await transaction.finish()
        }
    }
}
```

---

## 6. SK1 与 SK2 核心差异

| 对比项 | SK1 StoreKit1 | SK2 StoreKit2 |
| --- | --- | --- |
| 存储「待办交易标记」 | App 本地沙盒 | 苹果服务端 |
| 卸载 App 重装 | 沙盒清空，本地拿不到这笔待办交易 | 可以通过 `Transaction.all` 从苹果服务器拉回 |
| 凭证 | receipt（base64） | JWS |
| 回调模式 | Delegate 观察者模式 | async/await 异步流 |
| 天然兜底能力 | 弱，依赖本地沙盒 | 强，苹果服务器统一记录交易 |
| 门槛 | 兼容 iOS 9+ | 最低 iOS 15+ |

> 最关键一句话：
> **SK1：订单记录在苹果服务器，但 “通知 App 还有这笔单没处理” 的标记放在本地沙盒。沙盒丢了，App 就不知道这笔单存在。**
> **SK2：订单 + 待办状态全部在苹果服务器，App 启动主动去服务器拉待办。**

> 极端漏单场景：SK1，支付成功、凭证还没传给后端，用户直接卸载 App。
>
> - 本地沙盒没了 → App 下次重装不会再回调这笔订单
> - 后端从来没有收到 receipt，没有记录 originalTransactionId
> - 此时：**后端没有任何线索，无法主动去苹果查询这笔订单 → 直接丢单**
> - SK2 不会出现这个场景：重装后 Transaction.all 可以拉到这笔未 finish 订单

---

## 7. 服务端统一职责与验签逻辑

不管 SK1 还是 SK2，后端逻辑大体一致：

1. 接收客户端上传的 receipt / JWS
2. 调用苹果官方验签接口（生产 / 沙盒地址分开）
3. 验签成功，解析出：`originalTransactionId`、productId、购买时间、商品类型
4. **幂等校验：以 originalTransactionId 作为唯一主键**
   - 如果这个 id 已经发过权益 → 直接返回成功，不再重复发
5. 根据商品类型发放权益：
   - 消耗品：增加次数 / 道具
   - 非消耗品：永久解锁权限
   - 订阅：计算有效期，写入订阅到期时间
6. 落库，记录订单、用户 id、originalTransactionId、状态
7. 返回成功给客户端，客户端才可以 finish

> 补充：App Store Server Notification（V2 通知）
> 苹果主动推送通知给后端：退款、订阅过期、订阅取消等。
> 作用：**逆向回收权益**，不能用来替代客户端上报主链路。
> 原因：通知有可能延迟、丢、重试，不能作为发放权益依据。

---

## 8. 强制业务规则

1. ✅ 后端返回成功，才调用 finish
2. ✅ 幂等键必须用 `originalTransactionId`，不能用客户端随便生成的 id
3. ✅ 沙盒环境和生产环境验签地址分开，上线不要混用沙盒地址
4. ✅ 不能信任客户端传上来的价格、商品名称，一切以苹果验签返回的数据为准
5. ❌ 绝对不要客户端自己判断支付成功就给用户权益
6. ❌ 不要提前 finish，这是 SK1 最常见漏单根源
7. ❌ Server Notification 只做退款 / 过期回收，不做主链路发权益

---

## 9. 常见异常场景 & 处理方案

1. **支付成功，上传凭证时网络断了**
   - 客户端：不 finish；SK1 下次启动靠观察者回调；SK2 下次启动靠 Transaction.all
   - 优先依赖苹果原生兜底；如需更高可靠性，可自行持久化未完结交易
2. **后端服务宕机，上传失败**
   - 客户端不 finish；等用户下次打开 App，SDK 自动重新抛出这笔交易，再次上报
3. **用户多设备登录同一个 Apple ID 下单**
   - 后端靠 originalTransactionId 幂等，不会重复发权益
4. **用户申请退款**
   - 依靠苹果 Server Notification V2 收到退款事件，后端收回权益
5. **SK1 用户卸载重装，并且之前没有上传过 receipt**
   - 无解，属于 SK1 原生短板；想规避这个风险，新项目直接上 SK2

---

## 10. 小结

- SK1 老方案：兼容性好，但是**沙盒依赖带来天然漏单风险**，适合老项目维护
- SK2 新方案：基于苹果服务端交易记录，兜底强，async/await 写法干净，新项目优先选（iOS15+）
- 整个内购闭环核心：**苹果负责扣款和签名，我们负责验签、幂等、权益、不提前 finish**
- Server Notification 是附加能力，用来处理退款、订阅状态变更，不能做主链路