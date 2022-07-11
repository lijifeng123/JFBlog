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

<!--More-->

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

###### Timer事件源:

Timer事件源主要包括`NSTimer`、`CADisplayLink`、`performSelector:afterDelay:`等定时器触发的事件，这些事件也都是我们用代码写的。

- `NSTimer`

  我们都知道`NSTimer`是基于RunLoop实现的，所以我们得把`NSTimer`添加到RunLoop中它才会工作，那`NSTimer`是怎么基于RunLoop实现的呢？也就是说`NSTimer`的工作原理是怎么样的呢？我们在创建`NSTimer`的时候都会给一个时间间隔（多久触发一次定时器的回调），那么当我们把`NSTimer`添加到RunLoop后，RunLoop内部的处理是每执行一次`do...while`循环就记录下本次循环用了多长时间，然后累加上之前的时间，如果时间大于等于我们设置的时间间隔，就调用一下定时器的回调，否则不调用。比如说我们设置了`NSTimer`每搁1秒钟调用一次回调，假设RunLoop第一次`do-while`循环任务量较少（因为RunLoop不是专门用来处理定时器的，它还有Source0、Source1等很多事件需要处理，这些事件有可能很简单也有可能很繁重）只用了0.2s，第二次`do-while`循环用了0.3s，第三次`do-while`循环也用了0.3s，此时累计用了0.8s，第一次`do-while`循环任务量较多用了0.5s，那累计就是1.3s，也就是1.3s后才触发了定时器的回调，并不是1s，这也就是为什么我们说`NSTimer`有可能不准，所以要想定时器非常准时可以使用GCD定时器，GCD定时器是跟系统内核挂钩的，不依赖于RunLoop，所以非常准时，所以建议能用GCD定时器尽量用GCD定时器。

- `CADisplayLink`

  `CADisplayLink`和`NSTimer`的工作原理基本是一样的，只不过`CADisplayLink`的调用频率和屏幕的刷新频率一样，每1/60秒调用一次。

- `performSelector:afterDelay:`

  `performSelector:afterDelay:`，内部其实就是创建了一个`NSTimer`并添加到当前线程的RunLoop中。

### 三、RunLoop的运行流程

RunLoop的运行流程大概如下图：

![img](https://blog-1311875715.cos.ap-beijing.myqcloud.com/blog/1200.png)

RunLoop的运行流程大概如下伪代码：

```objectivec
// 选择DefaultMode进入RunLoop，
// 
// App一启动，会走main函数，
// main函数里面会调用UIApplicationMain函数，
// UIApplicationMain函数里面就调用该函数获取并启动了主线程对应的RunLoop。
void CFRunLoopRun() {
    CFRunLoopRunSpecific(CFRunLoopGetCurrent(), kCFRunLoopDefaultMode, 1.0e10);
}

// 选择指定的Mode进入RunLoop，也可以指定RunLoop的超时时间
// 
// 切换Mode时，系统就会调用这个方法来重新进入RunLoop
int CFRunLoopRunInMode(CFStringRef modeName, CFTimeInterval seconds) {
    return CFRunLoopRunSpecific(CFRunLoopGetCurrent(), modeName, seconds);
}


int CFRunLoopRunSpecific(runloop, modeName, seconds) {
   
    // 先根据modeName去查找Mode
    CFRunLoopModeRef currentMode = __CFRunLoopFindMode(runloop, modeName);
    // 如果Mode里没有Source0/Source1/Observer/Timer，则直接返回，不进入RunLoop
    if (__CFRunLoopModeIsEmpty(currentMode)) return;

    
    // 1、通知Observers：即将进入RunLoop
    __CFRunLoopDoObservers(runloop, currentMode, kCFRunLoopEntry);
    __CFRunLoopRun(runloop, currentMode, seconds) {
        
        int retVal = 0;
        do { // do...while循环
            // 2、通知Observers：线程即将处理Timer事件
            __CFRunLoopDoObservers(runloop, currentMode, kCFRunLoopBeforeTimers);
            // 3、通知Observers：线程即将处理Source事件
            __CFRunLoopDoObservers(runloop, currentMode, kCFRunLoopBeforeSources);
            
            
            // 4、处理Source0事件
            __CFRunLoopDoSources0(runloop, currentMode);
            // 5、判断有没有Source1事件
            if (__CFRunLoopServiceMachPort(dispatchPort, &msg)) {
                
                // 如果有，就跳转到handle_msg去处理
                goto handle_msg;
            }
            
            
            // 6、如果Source0事件处理完了、而且没有Source1事件，Timer事件的时间点还没到，则通知Observers：线程即将进入休眠
            __CFRunLoopDoObservers(runloop, currentMode, kCFRunLoopBeforeWaiting);
            // 7、线程休眠，等待被唤醒，这里是利用内核函数mach_msg实现的。线程进入休眠后，切换到内核态，会卡死在这个地方，因为线程不做任何事情，不占用任何CPU资源，仅仅是等待着被唤醒
            __CFRunLoopServiceMachPort(waitSet, &msg, sizeof(msg_buffer), &livePort, poll ? 0 : TIMEOUT_INFINITY, &voucherState, &voucherCopy) {
                mach_msg(msg, MACH_RCV_MSG, port);
            }
    
            
            // 8、通知Observers：线程被唤醒，切换到用户态
            __CFRunLoopDoObservers(runloop, currentMode, kCFRunLoopAfterWaiting);

            
        handle_msg: // 9、处理唤醒事件
            if (msg_is_timer) { // 如果是被Timer事件唤醒的
                
                // 则处理Timer事件
                __CFRunLoopDoTimers(runloop, currentMode, mach_absolute_time())
            } else if (msg_is_dispatch) { // 如果是被GCD dispatch到主线程的事件唤醒的
                
                // 则处理GCD dispatch到主线程的事件
                __CFRUNLOOP_IS_SERVICING_THE_MAIN_DISPATCH_QUEUE__(msg);
            } else { // 如果是被Source1事件唤醒的
                
                // 则处理Source1事件
                __CFRunLoopDoSource1(runloop, currentMode, source1, msg);
            }
            
            // 10、根据前面的执行结果，决定如何操作
            if (timeout) { // 如果RunLoop对应线程的休眠时间超过了超时时间
                
                // 则退出RunLoop
                retVal = kCFRunLoopRunTimedOut;
            } else if (__CFRunLoopIsStopped(runloop)) { // 如果RunLoop被强行终止了
                
                // 则退出RunLoop
                retVal = kCFRunLoopRunStopped;
            } if (__CFRunLoopModeIsEmpty(runloop, currentMode, previousMode)) { // 如果RunLoop当前Mode里没有Source0/Source1/Observer/Timer了
                
                // 则退出RunLoop
                retVal = kCFRunLoopRunFinished;
            }

            // 如果RunLoop没超时，也没被强行终止，当前Mode里也没空，则继续RunLoop
        } while (0 == retVal);
    }
    
    // 11、通知Observers：刚刚退出RunLoop
    __CFRunLoopDoObservers(runloop, currentMode, kCFRunLoopExit);
    
    return retVal;
}
```

比如说有这样一个问题：App启动、App运行过程中点击屏幕、App杀死，这个过程系统都发生了什么？

App 启动后，当走到`main`函数时，会调用`UIApplicationMain`函数，`UIApplicationMain`函数里面就会获取并启动主线程里面的RunLoop；当主线程处理完一件事后，没事做了就会进入休眠状态，而一旦我们点击屏幕。系统就会捕捉到这个事件为Source1事件来唤醒主线程，并把事件包装为Source0事件处理；之后App杀死，主线程销毁，主线程对应的RunLoop也就销毁了。（当然也可以结合事件传递和响应来分析）

### 四、RunLoop的实际应用

##### 1、处理NSTimer不工作的问题

Timer有两种创建方式，一种是`timerWithXXX`，一种是`scheduledWithXXX`。它们的区别是：**`timerWithXXX`只会创建一个Timer，不会把Timer添加到RunLoop中；`scheduledWithXXX`不仅会创建一个Timer，还会把Timer添加到RunLoop中，而且是添加到了`DefaultMode`下。**所以如果你发现Timer不工作，首先看看是不是用了`timerWithXXX`的创建方式，如果是，那么你可以手动把Timer添加到RunLoop中，或者换成`scheduledWithXXX`的创建方式。

```objectivec
+ (NSTimer *)timerWithTimeInterval:(NSTimeInterval)ti target:(id)aTarget selector:(SEL)aSelector userInfo:(nullable id)userInfo repeats:(BOOL)yesOrNo;
+ (NSTimer *)timerWithTimeInterval:(NSTimeInterval)interval repeats:(BOOL)repeats block:(void (^)(NSTimer *timer))block;

+ (NSTimer *)scheduledTimerWithTimeInterval:(NSTimeInterval)ti target:(id)aTarget selector:(SEL)aSelector userInfo:(nullable id)userInfo repeats:(BOOL)yesOrNo;
+ (NSTimer *)scheduledTimerWithTimeInterval:(NSTimeInterval)interval repeats:(BOOL)repeats block:(void (^)(NSTimer *timer))block;
```

所以如果你发现Timer不工作，首先看看是不是用了`timerWithXXX`的创建方式，如果是，那么你可以手动把Timer添加到RunLoop中，或者换成`scheduledWithXXX`的创建方式。

```objectivec
- (void)viewDidLoad {
    [super viewDidLoad];

    // 不工作
    static int count = 0;
    NSTimer *timer = [NSTimer timerWithTimeInterval:1 repeats:YES block:^(NSTimer * _Nonnull timer) {
        
        NSLog(@"%d", count++);
    }];
}


- (void)viewDidLoad {
    [super viewDidLoad];

    // 工作
    static int count = 0;
    NSTimer *timer = [NSTimer timerWithTimeInterval:1 repeats:YES block:^(NSTimer * _Nonnull timer) {
        
        NSLog(@"%d", count++);
    }];
    // 把Timer添加到RunLoop中
    [[NSRunLoop currentRunLoop] addTimer:timer forMode:(NSDefaultRunLoopMode)];
}


- (void)viewDidLoad {
    [super viewDidLoad];

    // 工作
    static int count = 0;
    NSTimer *timer = [NSTimer scheduledTimerWithTimeInterval:1 repeats:YES block:^(NSTimer * _Nonnull timer) {
        
        NSLog(@"%d", count++);
    }];
}
```

如果你发现Timer仅仅是在界面滑动时不工作，那么你可以把Timer添加到`CommonModes`下，因为Timer默认是被添加到`DefaultMode`下，所以在`TrackingMode`下不工作。

```objectivec
- (void)viewDidLoad {
    [super viewDidLoad];

    // 界面滑动和不滑动时，都可以工作
    static int count = 0;
    NSTimer *timer = [NSTimer scheduledTimerWithTimeInterval:1 repeats:YES block:^(NSTimer * _Nonnull timer) {
        
        NSLog(@"%d", count++);
    }];
    // 添加到CommonModes下
    [[NSRunLoop currentRunLoop] addTimer:timer forMode:(NSRunLoopCommonModes)];
}
```

如果你是在子线程中使用Timer，Timer默认是不工作的，因为子线程的RunLoop没有启动，虽然已经创建了（把Timer添加到RunLoop时系统会创建），因此我们需要手动启动一下RunLoop。

```objectivec
// 不工作
- (void)viewDidLoad {
    [super viewDidLoad];
    
    dispatch_async(dispatch_get_global_queue(0, 0), ^{
        
        // 用scheduledWithXXX创建定时器时，不仅会创建一个Timer，还会把Timer添加到RunLoop中，所以这个方法里获取了子线程的RunLoop了，也就是说子线程的RunLoop被创建了，就差启动
        [NSTimer scheduledTimerWithTimeInterval:1 repeats:YES block:^(NSTimer * _Nonnull timer) {
            
            NSLog(@"11");
        }];
    });
}


// 工作
- (void)viewDidLoad {
    [super viewDidLoad];
    
    dispatch_async(dispatch_get_global_queue(0, 0), ^{
        
        // 用scheduledWithXXX创建定时器时，不仅会创建一个Timer，还会把Timer添加到RunLoop中，所以这个方法里获取了子线程的RunLoop了，也就是说子线程的RunLoop被创建了，就差启动
        [NSTimer scheduledTimerWithTimeInterval:1 repeats:YES block:^(NSTimer * _Nonnull timer) {
            
            NSLog(@"11");
        }];
        
        // 手动启用一下子线程的RunLoop
        [[NSRunLoop currentRunLoop] run];
    });
}
```

#### 2、常驻线程

`AFNetworking`里就创建了一个子线程，并且让这个子线程一直活着，将来在某一刻时刻需要这个子线程做事情的时候就告诉它做事情。这样做的好处就是当你需要经常在子线程里做事情的时候可以节省线程的创建和销毁开销，如果你做完一个任务就销毁一个线程，做下一个任务又创建一个线程，做完又销毁，那这个过程是非常耗性能的，所以不如干脆让一个子线程一直存在于内存中。

我们知道**线程一执行完任务，它的生命周期就结束了，生命周期一结束，这个线程就无法再使用了，即便它还存在于内存中，但它已经不能做事情了。**所以我们说的**常驻线程其实是指保住线程的生命周期，不让它结束，而不是保住线程一直存在于内存中，**要想保住线程一直存在于内存中很简单啊，用强指针就可以了，而要想保住线程的生命周期就不能让线程执行完它的任务，那咱们任务里添加个`while(1)`死循环吧，可以是可以，但是这太占用CPU资源了吧，所以我们可以**用RunLoop来实现常驻线程，**即：

- **获取（即创建）子线程的RunLoop**
- **往RunLoop中添加一个Source或Observer或Timer（通常我们选择添加Source，其它两个太重了犯不着），以保证RunLoop不会因没有Source、Observer、Timer而退出**
- **启动RunLoop**
- **而如果想要结束常驻线程，则可以在适当的时机移除掉RunLoop里的Source**

```objectivec
@interface ViewController ()

@property (nonatomic, strong) NSThread *thread;

@end

@implementation ViewController

- (void)viewDidLoad {
    [super viewDidLoad];

    // 创建一个线程并启动
    self.thread = [[NSThread alloc] initWithTarget:self selector:@selector(threadAction) object:nil];
    [self.thread start];
}

- (void)threadAction {
    
    NSLog(@"threadAction：%@", [NSThread currentThread]);

    // 获取（即创建）子线程的RunLoop
    // 往RunLoop中添加一个Source或Observer或Timer（通常我们选择添加Source，其它两个太重了犯不着），以保证RunLoop不会因没有Source、Observer、Timer而退出
    [[NSRunLoop currentRunLoop] addPort:[NSMachPort port] forMode:NSDefaultRunLoopMode];
    // 启动RunLoop
    [[NSRunLoop currentRunLoop] run];
}

@end
```

```objectivec
// 假设我们要在点击屏幕的时候停掉线程
- (void)touchesBegan:(NSSet<UITouch *> *)touches withEvent:(UIEvent *)event {
    // 千万不能直接这样移除，因为这样[NSRunLoop currentRunLoop]获取的是主线程的RunLoop，而不是子线程的RnuLoop
//    [[NSRunLoop currentRunLoop] removePort:[NSMachPort port] forMode:NSDefaultRunLoopMode];
    
    // 一定要在子线程self.thread里移除
    [self performSelector:@selector(removePort) onThread:self.thread withObject:nil waitUntilDone:YES];
}

- (void)removePort {
    // 适当的时机，移除掉RunLoop里的Source，RunLoop就可以顺利退出，线程就会结束生命周期，进而线程销毁时，对应的RunLoop也销毁
    [[NSRunLoop currentRunLoop] removePort:[NSMachPort port] forMode:NSDefaultRunLoopMode];
}
```

