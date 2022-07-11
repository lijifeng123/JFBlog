---
title: RunLoop
date: 2022-07-10 19:11:38
tags: RunLoop
---

> 一、RunLoop是什么
>
> 二、RunLoop的底层实现
>
> ​		1、RunLoop和线程是什么关系
>
> ​		2、RunLoop的运行模式
>
> ​		3、Source0事件源、Source1事件源、Observer、Timer事件源
>
> 三、RunLoop的运行流程
>
> 四、RunLoop的实际应用
>
> ​		1、处理NSTimer不工作的问题
>
> ​		2、常驻线程

### 一、RunLoop是什么

RunLoop运行循环，它就是一个OC对象，它的主要作用有三个：

- **保持App的持续运行**，具体而言，我们的App在启动后就会在`main`函数那里创建并启动主线程对应的RunLoop，这个RunLoop内部维护着一个`do...while`循环，正是因为`do...while`循环的存在，才使得主线程得以保活，即主线程不会执行完任务立即退出，也就是App得以保活，否则App一启动执行完`main`函数就退出了；
- **处理App的各种事件**，具体说，RunLoop内部的`do...while`循环里循环处理着App的各种事件，包括Source0事件、Source1事件、Timer事件；
- **线程的休眠唤醒则是RunLoop区别于其他语言EventLoop的核心所在，线程没事做就休眠，有事做就唤醒，这样可以节省CPU资源。**

### 二、RunLoop的底层实现

RunLoop是`NSRunLoop`类型的，它的C语言实现为`CFRunLoopRef`，因为[CFRunLoopRef](https://links.jianshu.com/go?to=https%3A%2F%2Fopensource.apple.com%2Ftarballs%2FCF%2F)是开源的，所以接下来我们会从它的源码来看看RunLoop的底层实现。

```objectivec
typedef struct __CFRunLoop *CFRunLoopRef;
struct __CFRunLoop {
    pthread_t _pthread; // RunLoop对应的线程

    CFMutableSetRef _modes; // RunLoop所有的运行模式
    CFRunLoopModeRef _currentMode; // RunLoop当前的运行模式

    CFMutableSetRef _commonModes; // RunLoop“特殊的运行模式”
    CFMutableSetRef _commonModeItems; // RunLoop“特殊的运行模式“里的items
};

typedef struct __CFRunLoopMode *CFRunLoopModeRef;
struct __CFRunLoopMode {
    CFStringRef _name; // 运行模式的名字，如@"NSDefaultRunLoopMode"、@"UITrackingRunLoopMode"
    CFMutableSetRef _sources0; // Set，Source0事件源集合
    CFMutableSetRef _sources1; // Set，Source1事件源集合
    CFMutableArrayRef _observers; // Array，观察者数组
    CFMutableArrayRef _timers; // Array，Timer事件源数组
};
```

#### 1、RunLoop和线程的关系

苹果并没有为我们提供创建RunLoop的API，仅仅提供了获取RunLoop的API。

```objectivec
// Core Foundation框架
CFRunLoopGetMain(); // 获取主线程对应的RunLoop
CFRunLoopGetCurrent(); // 获取当前线程对应的RunLoop

// Foundation框架，对Core Foundation框架函数的封装
[NSRunLoop mainRunLoop]; // 获取主线程对应的RunLoop
[NSRunLoop currentRunLoop]; // 获取当前线程对应的RunLoop
```

这两套API的底层实现大概如下（伪代码，详见`CFRunLoop.c`文件）：

```objectivec
CFRunLoopRef CFRunLoopGetMain() {
    return _CFRunLoopGet(pthread_main_thread_np());
}
 
CFRunLoopRef CFRunLoopGetCurrent() {
    return _CFRunLoopGet(pthread_self());
}


// 一个全局的字典，线程是key，RunLoop是value
static CFMutableDictionaryRef __CFRunLoops;

CFRunLoopRef _CFRunLoopGet(pthread_t thread) {
    
    if (!__CFRunLoops) { // 如果是第一次获取RunLoop（那肯定是获取主线程对应的RunLoop，因为App一启动系统就会自动去获取主线程对应的RunLoop，我们自己写的获取且早着呢）

        // 初始化全局的字典
        __CFRunLoops = CFDictionaryCreateMutable();
        
        // 创建主线程对应的RunLoop
        CFRunLoopRef mainLoop = __CFRunLoopCreate(pthread_main_thread_np());
        // 主线程为key，主线程对应的RunLoop为value，存入全局的字典里
        CFDictionarySetValue(dict, pthread_main_thread_np(), mainLoop);
    }
    
    // 从全局的字典里读取某个线程对应的RunLoop
    CFRunLoopRef loop = CFDictionaryGetValue(__CFRunLoops, thread);
    
    if (!loop) { // 如果读取不到
        
        // 创建该线程对应的RunLoop，
        loop = __CFRunLoopCreate(thread);
        // 该线程为key，该线程对应的RunLoop为value，存入全局的字典里
        CFDictionarySetValue(__CFRunLoops, thread, loop);
    }

    // 注册一个回调，当某个线程销毁时，也销毁该线程对应的RunLoop
    _CFSetTSD(thread, loop, __CFFinalizeRunLoop);

    return loop;
}
```

> - RunLoop是基于线程来管理的，他们是一一对应的关系，共同存在于一个全局的字典里，线程是`key`，RunLoop是`value`；
> - 对于主线程的RunLoop来说，App一启动系统就会自动创建并启动，而对子线程的RunLoop来说，除非我们主动去获取，否则不会创建，我们获取也就是创建子线程的RunLoop后，还需要手动启动它；
> - RunLoop的销毁发生在线程销毁时。

#### 2、RunLoop的运行模式

![img](https://blog-1311875715.cos.ap-beijing.myqcloud.com/blog/1140.png)

> - **系统为RunLoop提供了好几种运行模式，其中`NSDefaultRunLoopMode`和`UITrackingRunLoopMode`是我们经常使用的。`NSDefaultRunLoopMode`是RunLoop默认的运行模式，大多数时候RunLoop就运行在这种模式下，`UITrackingRunLoopMode`是界面滑动时RunLoop的运行模式，系统会自动完成不同情况下这两种运行模式的切换；**
> - **当然RunLoop还有一种“特殊的运行模式”，就是`NSRunLoopCommonModes`，严格来说它不是一种运行模式，而是一些运行模式的组合。比如说系统会默认把`NSDefaultRunLoopMode`和`UITrackingRunLoopMode`添加到`NSRunLoopCommonModes`里，RunLoop运行在`NSRunLoopCommonModes`模式时，并不是说它就真得运行在`NSRunLoopCommonModes`下，而是说RunLoop在切换真正的运行模式时会自动把一个运行模式里面的Source0/Source1/Observer/Timer同步到另一个运行模式里；**
> - **一个RunLoop可以有多个运行模式，而每个运行模式里又可以有多个Source0/Source1/Observer/Timer，但是RunLoop一次只能运行在一个运行模式下，这个运行模式被称为CurrentMode，如果要切换运行模式，就得退出RunLoop，重新选择一个运行模式运行。RunLoop分Mode的目的就是为了把不同Mode里的Source0/Source1/Observer/Timer给隔离开来，在这个模式下的时候就做专心做这个模式里的事，在那个模式下的时候就专心做那个模式里的事，让它们互相不影响，当然如果你想一件事能在多个模式下做，那就把它扔到`CommonModes`下。**

#### 3、Source0事件源、Source1事件源、Observer、Timer事件源

###### Source0事件源：

###### Source0事件源主要包括原始指针事件、手势事件、`performSelector:onThread:`等事件，这些事件都是我们用代码写的。

###### Source1事件源：

Source1事件源主要包括锁屏、静音、靠近传感器、加速等系统事件，还有基于`Port`的线程间通信事件，这些事件都不是我们用代码写的，是系统发出的。

此外需要注意的是原始指针事件、手势事件也是首先被捕捉为Source1事件来唤醒主线程，然后再包装为Source0事件处理的。

###### Observer：

Observer不是RunLoop的事件源，而是RunLoop的观察者，它主要用来观察RunLoop状态的变化，从而触发回调做一些自定义的处理，比如系统的UI刷新和`autoreleasepool`创建、销毁就是通过Observer观察RunLoop的状态实现的。RunLoop的状态有如下几个：

```objectivec
typedef CF_OPTIONS(CFOptionFlags, CFRunLoopActivity) {
    kCFRunLoopEntry         = (1UL << 0), // 即将进入RunLoop
    kCFRunLoopBeforeTimers  = (1UL << 1), // 线程即将处理Timer事件
    kCFRunLoopBeforeSources = (1UL << 2), // 线程即将处理Source事件
    kCFRunLoopBeforeWaiting = (1UL << 5), // 线程即将进入休眠
    kCFRunLoopAfterWaiting  = (1UL << 6), // 线程被唤醒
    kCFRunLoopExit          = (1UL << 7), // 刚刚退出RunLoop
};
```

- UI刷新

  App一启动，系统就会添加一个Observer，监听主线程对应的RunLoop，主要负责UI刷新。这个Observer监听的是“线程即将进入休眠”和“刚刚退出RunLoop”两个状态，它的回调里才是真正的刷新UI。也就是说我们编写的UI代码，如设置了view的frame、设置view的背景色等，并不是执行到那一行代码时就立即刷新生效，而是RunLoop的线程即将进入休眠或者刚刚退出退出RunLoop时才刷新生效的。

- `autoreleasepool`的创建和销毁

  App一启动，系统就会添加两个Observer，监听主线程对应的RunLoop，主要负责`autoreleasepool`的创建和销毁。第一个Observer监听的是“即将进入RunLoop”状态，它的回调里会创建一个`autoreleasepool`，这个Observer的优先级最高，以此保证`autoreleasepool`发生在其他所有回调之前，这样我们项目里的`autorelease`对象就可以放在这个`autoreleasepool`里面了。第二个Obsever监听的是“线程即将进入休眠”和“刚刚退出RunLoop”两个状态，“线程即将进入休眠”时，它的回调里会销毁`autoreleasepool`，这个Obsever的优先级最低，以此保证销毁`autoreleasepool`发生在其他所有回调之后，这样我们项目里的`autorelease`对象就可以顺利执行一次`release`操作使得引用计数-1。简单说，我们可以把线程的唤醒做事到线程休眠看作是一次RunLoop循环，App运行过程中会有无数次的RunLoop循环，每一次的RunLoop循环开始时系统都会创建一个`autoreleasepool`，并把这一次的`autorelease`对象都放进去，然后等这一次RunLoop循环结束时统一让`autorelease`对象的引用计数-1。

