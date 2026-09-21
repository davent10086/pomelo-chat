请对当前项目建立一套完整、系统、可重复执行、可长期维护、适合真实生产项目的自动化测试体系。

这次任务不是简单运行现有测试，也不是只补几个单元测试。

你的目标是：

1. 全面理解当前项目。

2. 识别测试空白和高风险模块。

3. 为项目补齐单元测试、集成测试、API 测试、数据库测试、前端测试、E2E 测试、WebSocket/SSE 测试、LLM/Agent 测试、音视频通话测试、并发测试、安全测试、性能测试和异常恢复测试。

4. 主动构造开发者容易忽略的边界条件。

5. 发现 Bug 时先构造稳定复现测试，再修复业务代码，再做回归测试。

6. 最终确保整个项目可以通过一组统一测试命令进行验证。

7. 所有测试数据必须和正式数据隔离。

8. 测试结束后自动清理本次测试创建的数据。

9. 允许使用真实的大模型 API Key 和真实模型 API 进行 LLM/Agent 集成测试。

10. 不要默认使用 Mock 数据模拟真实模型结果。

11. 如果项目包含音视频通话，必须测试 WebRTC、信令、ICE、STUN/TURN、媒体设备、弱网、重连和资源释放。

12. 不要只测试 Happy Path，必须主动制造失败链路。

━━━━━━━━━━━━━━━━━━━━  
一、第一阶段：项目分析  
━━━━━━━━━━━━━━━━━━━━

不要立即开始大量写测试。

首先完整阅读项目，包括但不限于：

README  
package.json  
pnpm-lock.yaml  
yarn.lock  
go.mod  
go.sum  
requirements.txt  
pyproject.toml  
Dockerfile  
.env.example  
数据库 Schema  
Migration  
ORM 配置  
API 路由  
Controller  
Service  
Repository  
Middleware  
Auth  
WebSocket  
SSE  
WebRTC  
RTC Signaling  
STUN/TURN  
媒体设备相关代码  
Redis  
缓存代码  
Agent  
LLM  
RAG  
Embedding  
文件上传  
外部 API  
前端页面  
前端组件  
状态管理  
已有测试目录  
CI/CD  
GitHub Actions

先输出项目分析结果：

1. 技术栈

2. 项目架构

3. 前端框架

4. 后端框架

5. 数据库

6. ORM

7. Redis / Cache

8. WebSocket / SSE

9. WebRTC / 音视频通话

10. STUN/TURN 配置

11. LLM Provider

12. Agent / RAG

13. 外部服务

14. 当前已有测试

15. 当前测试覆盖空白

16. 高风险模块

17. 核心业务链路

同时列出：

P0 高风险模块  
P1 高风险模块  
P2 一般风险模块

优先测试 P0/P1。

━━━━━━━━━━━━━━━━━━━━  
二、测试体系目录  
━━━━━━━━━━━━━━━━━━━━

根据项目真实技术栈建立合理的测试目录。

参考：

tests/

unit/

integration/

api/

database/

auth/

websocket/

streaming/

rtc/

webrtc/

audio-video/

llm/

agent/

rag/

cache/

upload/

security/

concurrency/

performance/

e2e/

fixtures/

helpers/

cleanup/

不要把所有测试堆在一个文件。

测试文件按照真实业务模块组织。

━━━━━━━━━━━━━━━━━━━━  
三、单元测试 Unit Test  
━━━━━━━━━━━━━━━━━━━━

优先覆盖：

utils  
validators  
parsers  
formatters  
transformers  
service business logic  
state machine  
cache key  
协议转换  
请求转换  
响应转换  
Token 计算  
权限判断  
状态转换  
数据处理函数  
WebRTC 状态处理  
SDP/ICE 处理  
通话状态机

每个核心函数必须考虑：

正常值  
null  
undefined  
空字符串  
空数组  
空对象  
非法类型  
0  
-1  
最大值  
超过最大值  
超大整数  
小数  
NaN  
Infinity  
中文  
英文  
emoji  
Unicode  
换行  
Tab  
超长字符串  
重复数据  
特殊字符

不要只测试正常路径。

━━━━━━━━━━━━━━━━━━━━  
四、字符串边界测试  
━━━━━━━━━━━━━━━━━━━━

所有用户输入必须考虑：

""  
" "  
"\n"  
"\t"  
超长字符串  
中文  
英文  
emoji  
生僻 Unicode  
零宽字符  
HTML  
Markdown  
JSON 字符串  
URL 编码  
SQL 特殊字符  
连续空格  
首尾空格  
特殊符号

例如：

../../etc/passwd

' OR 1=1 --

${...}

{{...}}

不要假设输入是干净的。

━━━━━━━━━━━━━━━━━━━━  
五、数字边界  
━━━━━━━━━━━━━━━━━━━━

所有数字参数测试：

0  
1  
-1  
最大值  
最大值+1  
极大整数  
极小负数  
浮点数  
NaN  
Infinity  
字符串形式数字  
非法字符串  
null  
undefined

━━━━━━━━━━━━━━━━━━━━  
六、数组和集合  
━━━━━━━━━━━━━━━━━━━━

测试：

[]  
单元素  
大量元素  
重复元素  
null 元素  
undefined 元素  
非法类型  
超过最大长度  
顺序异常  
重复 ID  
不存在 ID

━━━━━━━━━━━━━━━━━━━━  
七、API 集成测试  
━━━━━━━━━━━━━━━━━━━━

逐个检查项目所有重要 API Endpoint。

每个 API 至少测试：

正常请求  
空 body  
非法 JSON  
Content-Type 错误  
缺字段  
多字段  
字段类型错误  
非法 ID  
超长 ID  
不存在资源  
资源已删除  
重复请求  
错误 HTTP Method  
无 Authorization  
Token 错误  
Token 过期  
Token 被撤销  
权限不足  
用户 A 访问用户 B 资源  
管理员接口被普通用户访问  
请求超时  
客户端主动取消  
上游 400  
上游 401  
上游 403  
上游 404  
上游 408  
上游 429  
上游 500  
上游 502  
上游 503  
上游空响应  
上游非法 JSON

必须验证：

HTTP Status Code  
Response Schema  
错误码  
错误信息  
数据是否被错误写入数据库

不能所有异常都返回 200 或 500。

━━━━━━━━━━━━━━━━━━━━  
八、数据库测试  
━━━━━━━━━━━━━━━━━━━━

必须使用测试环境数据库。

优先：

DATABASE_URL_TEST

TEST_DATABASE_URL

NODE_ENV=test

APP_ENV=test

禁止自动连接生产数据库。

测试启动时检查数据库连接信息。

如果发现：

NODE_ENV=production

APP_ENV=production

或者数据库名称明显属于 production

立即停止测试。

测试：

Create  
Read  
Update  
Delete  
重复 Create  
重复 Delete  
Unique Constraint  
Foreign Key  
null  
空字符串  
超长字符串  
不存在资源  
已删除资源  
批量插入  
分页  
排序  
过滤  
page=0  
page=-1  
pageSize=0  
超大 pageSize  
事务  
Rollback  
并发修改  
并发删除  
并发新增

重点验证：

接口报错以后数据库是否已经部分写入。

避免半成功状态。

━━━━━━━━━━━━━━━━━━━━  
九、测试数据生命周期  
━━━━━━━━━━━━━━━━━━━━

所有测试创建的数据必须拥有唯一：

test_run_id

每次执行测试：

test_run_id = UUID

例如：

test_20260920_f84d31

所有本次测试数据尽可能携带：

test_run_id

或者：

source = automated_test

metadata.test_run_id

environment = test

本次测试产生的：

用户  
会话  
消息  
Agent Run  
Memory  
Embedding  
文件  
工具调用  
缓存  
通话记录  
RTC Session  
Room  
Call Record  
Call Participant  
临时任务  
数据库记录

全部必须可以通过 test_run_id 找到。

━━━━━━━━━━━━━━━━━━━━  
十、测试结束自动清理  
━━━━━━━━━━━━━━━━━━━━

每一个测试模块必须实现 cleanup。

推荐：

Jest afterEach / afterAll

Vitest afterEach / afterAll

Playwright afterEach / afterAll

pytest fixture teardown

Go t.Cleanup

任何测试即使失败，也必须执行 cleanup。

例如：

try:  
create_test_data()  
run_test()  
assert_result()  
finally:  
cleanup()

不能因为 Assertion Failed 导致垃圾数据留在数据库。

━━━━━━━━━━━━━━━━━━━━  
十一、清理原则  
━━━━━━━━━━━━━━━━━━━━

禁止：

DELETE FROM users  
TRUNCATE TABLE  
DROP DATABASE  
FLUSHALL  
清空整个向量库  
清空整个对象存储 Bucket

只能删除当前 test_run_id 创建的数据。

例如：

DELETE FROM messages  
WHERE test_run_id = ?

如果没有 test_run_id 字段，可以通过：

测试用户 ID  
测试会话 ID  
测试通话 ID  
UUID 前缀  
metadata

进行关联删除。

━━━━━━━━━━━━━━━━━━━━  
十二、Redis 测试数据  
━━━━━━━━━━━━━━━━━━━━

所有 Redis Test Key 使用：

test:{test_run_id}:xxx

例如：

test:test_abc123:session:1

测试结束只删除：

test:{test_run_id}:*

禁止：

FLUSHALL  
FLUSHDB

除非使用完全独立的一次性测试 Redis。

━━━━━━━━━━━━━━━━━━━━  
十三、对象存储和文件  
━━━━━━━━━━━━━━━━━━━━

测试文件统一写入：

tests/tmp/{test_run_id}/

或者：

tmp/tests/{test_run_id}/

测试结束递归删除。

对象存储使用：

tests/{test_run_id}/xxx

测试完成后删除整个：

tests/{test_run_id}/

不得删除其他对象。

━━━━━━━━━━━━━━━━━━━━  
十四、向量数据库  
━━━━━━━━━━━━━━━━━━━━

如果使用：

Qdrant  
Milvus  
Pinecone  
Elasticsearch  
pgvector  
Weaviate  
Chroma

测试数据必须使用：

test namespace

或者：

metadata.test_run_id

测试结束只删除本次 test_run_id 数据。

禁止清空正式 Index / Collection。

━━━━━━━━━━━━━━━━━━━━  
十五、Authentication / Authorization  
━━━━━━━━━━━━━━━━━━━━

测试：

未登录  
正常登录  
Token 错误  
Token 过期  
Token 被撤销  
伪造 Token  
权限不足  
管理员权限  
普通用户权限  
用户 A 访问用户 B 数据  
用户 A 修改用户 B 数据  
用户 A 删除用户 B 数据

重点测试：

IDOR

不要只测试前端按钮隐藏。

必须直接请求后端 API 验证权限。

━━━━━━━━━━━━━━━━━━━━  
十六、WebSocket 测试  
━━━━━━━━━━━━━━━━━━━━

如果存在 WebSocket，必须建立真实自动化测试。

覆盖：

连接成功  
连接失败  
未登录连接  
Token 错误  
Token 过期  
连接中 Token 失效  
重复连接  
一个账号多个设备  
心跳  
Ping  
Pong  
心跳超时  
客户端断网  
服务器关闭  
服务端重启  
重新连接  
reconnect storm  
消息重复  
消息乱序  
消息丢失  
空消息  
超大消息  
非法 JSON  
非法 event type  
快速连续发送消息  
并发连接

至少测试：

1  
10  
50  
100

个连接。

检查：

Connection Leak  
Memory Leak  
重复消息  
消息丢失  
Zombie Connection

━━━━━━━━━━━━━━━━━━━━  
十七、SSE / Streaming  
━━━━━━━━━━━━━━━━━━━━

如果项目存在 SSE 或 AI Streaming：

测试：

正常完整流  
首 Token 很慢  
200 但是 body 为空  
只返回 1 Token  
只返回 2 Token  
输出一半断开  
没有结束事件  
重复结束事件  
delta 顺序异常  
JSON 跨 chunk  
UTF-8 跨 chunk  
tool_call 跨 chunk  
thinking 跨 chunk  
reasoning 跨 chunk  
上游主动断开  
客户端主动 Abort  
客户端刷新页面  
客户端关闭 Tab  
Timeout  
429  
500  
502  
503  
Connection Reset

验证：

不会 Crash  
不会无限 Loading  
不会无限重连  
不会重复追加内容  
不会重复创建 Message  
不会重复执行 Tool

━━━━━━━━━━━━━━━━━━━━  
十八、真实 LLM API 测试  
━━━━━━━━━━━━━━━━━━━━

LLM 测试允许使用真实 API Key。

优先真实调用：

OpenAI  
Anthropic / Claude  
Gemini  
或者项目实际支持的兼容 API。

API Key 必须通过环境变量读取，例如：

OPENAI_API_KEY  
ANTHROPIC_API_KEY  
GEMINI_API_KEY  
OPENAI_BASE_URL  
ANTHROPIC_BASE_URL  
GEMINI_BASE_URL  
TEST_MODEL_NAME

禁止：

把 API Key 写进测试代码  
把 API Key 提交 Git  
把 API Key 打进日志  
把完整 Authorization Header 输出到报告。

━━━━━━━━━━━━━━━━━━━━  
十九、LLM 测试原则  
━━━━━━━━━━━━━━━━━━━━

不要默认 Mock 一个固定成功结果冒充真实模型。

优先使用真实模型 API。

如果当前环境没有对应 API Key：

明确标记：

SKIPPED: missing OPENAI_API_KEY

不要伪造模型成功返回。

只有无法稳定安全触发的底层网络故障，才允许使用：

Fault Injection

本地测试 Provider

测试代理

进行异常测试。

━━━━━━━━━━━━━━━━━━━━  
二十、真实 LLM 正常行为测试  
━━━━━━━━━━━━━━━━━━━━

测试：

最简单 Prompt  
中文 Prompt  
英文 Prompt  
emoji  
Unicode  
多轮对话  
System Prompt  
长 Prompt  
结构化输出  
JSON Schema  
Tool Calling  
Function Calling  
Streaming  
Non-streaming  
Reasoning  
Thinking

如果 Provider 支持。

验证：

HTTP Status  
Content  
finish_reason  
stop_reason  
usage  
input tokens  
output tokens  
request id  
TTFB  
total latency  
响应是否符合 Schema。

不要断言完整自然语言固定一致。

应该验证：

response 非空  
Schema 正确  
字段存在  
类型正确  
工具调用符合约定  
状态正确。

━━━━━━━━━━━━━━━━━━━━  
二十一、真实 LLM 异常测试  
━━━━━━━━━━━━━━━━━━━━

测试：

错误 API Key  
没有 API Key  
错误模型名  
不存在模型  
非法参数  
不支持参数  
超长上下文  
Context Length Exceeded  
400  
401  
403  
404  
408  
429  
500  
502  
503  
Timeout  
客户端 Cancel  
流式 Abort

不要为了制造 429 / 500 / 502 / 503 故意高频攻击真实 API。

不能稳定触发时使用 Fault Injection。

━━━━━━━━━━━━━━━━━━━━  
二十二、LLM Streaming 真实测试  
━━━━━━━━━━━━━━━━━━━━

验证：

stream start  
delta  
tool call  
thinking  
reasoning  
stop  
finish reason  
usage  
Request ID

客户端 Abort 后：

连接是否释放  
数据库是否停止写入  
Agent 是否停止  
Message 是否正确结束  
是否继续执行 Tool  
是否出现重复输出

━━━━━━━━━━━━━━━━━━━━  
二十三、LLM 成本保护  
━━━━━━━━━━━━━━━━━━━━

真实 LLM 测试必须控制费用。

设置：

尽可能短输入  
合理 max_tokens  
避免无意义长输出  
禁止无限 Agent 循环  
禁止默认使用最昂贵模型

通过：

TEST_MODEL_NAME

配置测试模型。

高级模型专属功能标记：

expensive  
integration  
manual

不要让高成本测试默认每次 commit 自动执行。

━━━━━━━━━━━━━━━━━━━━  
二十四、Agent 测试  
━━━━━━━━━━━━━━━━━━━━

Agent 测试优先真实调用 LLM。

测试：

正常推理  
多轮推理  
真实 Tool Calling  
Tool 参数  
Tool 正常返回  
Tool 空返回  
Tool 非法 JSON  
Tool 404  
Tool 500  
Tool Timeout  
重复 Tool Call  
Agent 重复调用同一工具  
模型没有调用预期 Tool  
模型调用不存在 Tool  
Tool 参数缺少字段  
Tool 参数类型错误  
用户主动取消  
Agent Timeout  
Agent 最大迭代次数  
数据库失败  
Redis 失败  
LLM 失败  
向量数据库失败

必须验证 Agent 存在：

maxIterations  
timeout  
cancel  
错误恢复  
无限循环保护

━━━━━━━━━━━━━━━━━━━━  
二十五、Agent 数据清理  
━━━━━━━━━━━━━━━━━━━━

Agent 测试产生的：

Agent Run  
Messages  
Tool Calls  
Memories  
Traces  
Usage

全部绑定 test_run_id。

测试结束自动删除。

━━━━━━━━━━━━━━━━━━━━  
二十六、RAG 测试  
━━━━━━━━━━━━━━━━━━━━

测试：

正常检索  
空知识库  
空 Query  
不存在匹配  
一条匹配  
大量匹配  
重复文档  
TopK=0  
TopK=1  
TopK 很大  
Embedding API Error  
Embedding Timeout  
Vector DB Down  
维度不匹配  
metadata 缺失  
文档为空  
文档超长  
脏数据

━━━━━━━━━━━━━━━━━━━━  
二十七、缓存测试  
━━━━━━━━━━━━━━━━━━━━

测试：

Cache Hit  
Cache Miss  
TTL  
TTL 到期边界  
Cache Key Collision  
错误缓存数据  
Redis Timeout  
Redis Down  
并发请求同一 Key  
Cache Stampede  
Cache Penetration  
热点 Key

Redis 不可用时系统不能整体 Crash。

━━━━━━━━━━━━━━━━━━━━  
二十八、文件上传  
━━━━━━━━━━━━━━━━━━━━

测试：

正常文件  
0 byte  
1 byte  
最大大小  
超过最大大小  
错误 MIME  
伪造 MIME  
伪造扩展名  
没有扩展名  
中文文件名  
emoji 文件名  
超长文件名  
相同文件名  
重复上传  
并发上传  
上传中断  
损坏文件  
../../xx  
../xx

测试 Path Traversal。

━━━━━━━━━━━━━━━━━━━━  
二十九、断点续传  
━━━━━━━━━━━━━━━━━━━━

如果存在分片上传：

chunk 乱序  
chunk 缺失  
chunk 重复  
chunk hash 错误  
最后一个 chunk 大小异常  
merge 失败  
上传中断  
恢复上传  
重复 merge

━━━━━━━━━━━━━━━━━━━━  
三十、音视频通话总体测试  
━━━━━━━━━━━━━━━━━━━━

如果项目存在：

语音通话  
视频通话  
WebRTC  
RTC SDK  
房间  
多人会议  
屏幕共享

必须建立独立音视频测试体系。

不要只验证“能打通”。

至少验证：

发起呼叫  
接听  
拒绝  
取消  
挂断  
忙线  
无人接听  
超时  
双方同时呼叫  
重复呼叫  
快速点击呼叫  
快速接听  
快速挂断  
呼叫过程中刷新  
通话过程中刷新  
浏览器崩溃  
页面关闭  
客户端断网  
服务端重启  
WebSocket 信令断开

━━━━━━━━━━━━━━━━━━━━  
三十一、音视频权限测试  
━━━━━━━━━━━━━━━━━━━━

测试：

首次请求麦克风权限

允许麦克风

拒绝麦克风

永久拒绝麦克风

首次请求摄像头权限

允许摄像头

拒绝摄像头

永久拒绝摄像头

权限被系统撤销

通话过程中权限被撤销

浏览器没有媒体权限

HTTP 非安全上下文导致 getUserMedia 不可用

系统没有摄像头

系统没有麦克风

检查：

不能无限 Loading

不能直接 Crash

必须给用户明确错误状态。

━━━━━━━━━━━━━━━━━━━━  
三十二、媒体设备测试  
━━━━━━━━━━━━━━━━━━━━

测试：

只有一个麦克风

多个麦克风

只有一个摄像头

多个摄像头

USB 麦克风插入

USB 麦克风拔出

摄像头插入

摄像头拔出

蓝牙耳机连接

蓝牙耳机断开

通话过程中切换麦克风

通话过程中切换摄像头

切换前置/后置摄像头

设备不存在

deviceId 已失效

默认设备发生改变

验证：

media track 是否正确切换

旧 track 是否 stop

是否发生资源泄漏。

━━━━━━━━━━━━━━━━━━━━  
三十三、WebRTC Signaling 测试  
━━━━━━━━━━━━━━━━━━━━

测试完整信令：

call invite

offer

answer

ICE candidate

accept

reject

cancel

hangup

busy

timeout

测试：

offer 丢失

answer 丢失

ICE candidate 丢失

ICE candidate 重复

ICE candidate 乱序

hangup 重复

accept 重复

旧通话信令迟到

不同 callId 的信令混入

非法 callId

过期 callId

用户 A 的 candidate 被发送给用户 C

必须防止串线。

━━━━━━━━━━━━━━━━━━━━  
三十四、SDP 测试  
━━━━━━━━━━━━━━━━━━━━

测试：

合法 Offer SDP

合法 Answer SDP

空 SDP

非法 SDP

截断 SDP

重复 SDP

旧 SDP

SDP type 错误

Offer 当 Answer

Answer 当 Offer

codec 缺失

音频轨缺失

视频轨缺失

SDP 协商失败

setLocalDescription 失败

setRemoteDescription 失败

确保异常不会导致客户端永久卡在 Calling / Connecting。

━━━━━━━━━━━━━━━━━━━━  
三十五、ICE 测试  
━━━━━━━━━━━━━━━━━━━━

测试 ICE 状态：

new

checking

connected

completed

disconnected

failed

closed

模拟：

无 candidate

只有 host candidate

srflx candidate

relay candidate

ICE gathering 很慢

ICE failed

ICE disconnected

ICE restart

ICE candidate 迟到

ICE candidate 在 setRemoteDescription 前到达

检查 candidate queue 是否正确。

━━━━━━━━━━━━━━━━━━━━  
三十六、STUN / TURN 测试  
━━━━━━━━━━━━━━━━━━━━

测试：

STUN 正常

STUN 不可用

STUN Timeout

TURN 正常

TURN 不可用

TURN 凭证错误

TURN 凭证过期

TURN TCP

TURN UDP

TURN TLS

只允许 relay

TURN Server 切换

多 TURN Server

验证：

严格 NAT 环境下能否通过 TURN 建立连接。

不能只在同一个局域网里测试。

━━━━━━━━━━━━━━━━━━━━  
三十七、音频测试  
━━━━━━━━━━━━━━━━━━━━

测试：

正常音频

静音

取消静音

快速重复 mute/unmute

麦克风无输入

极低音量

音频 Track ended

麦克风设备消失

切换麦克风

对方无音频

本地无音频

音频单向

音频断续

验证：

静音状态是否同步

UI 状态是否正确

Track enabled 状态是否正确。

━━━━━━━━━━━━━━━━━━━━  
三十八、视频测试  
━━━━━━━━━━━━━━━━━━━━

测试：

正常视频

关闭摄像头

打开摄像头

快速切换

视频 Track ended

摄像头拔出

切换摄像头

前后摄像头切换

对方无视频

本地无视频

视频单向

黑屏

视频首帧极慢

检查：

video element 状态

srcObject

MediaStream

Track 生命周期

摄像头关闭后是否真正释放硬件。

━━━━━━━━━━━━━━━━━━━━  
三十九、屏幕共享测试  
━━━━━━━━━━━━━━━━━━━━

如果支持屏幕共享：

测试：

开始共享

停止共享

用户主动点击浏览器 Stop Sharing

共享整个屏幕

共享窗口

共享 Tab

拒绝共享

共享轨道结束

共享时切回摄像头

共享过程中断网

共享过程中对方挂断

重复点击共享

两次共享竞争

检查：

屏幕共享 Track 结束以后是否恢复 Camera Track。

━━━━━━━━━━━━━━━━━━━━  
四十、音视频状态机  
━━━━━━━━━━━━━━━━━━━━

至少验证：

idle

calling

ringing

connecting

connected

reconnecting

ended

rejected

busy

failed

cancelled

timeout

尝试非法状态：

ended → connected

rejected → connected

busy → connected

connected → ringing

cancelled → accepted

同一个 Call 被 accept 两次

同一个 Call 被 hangup 多次

后端必须拒绝非法状态转换。

━━━━━━━━━━━━━━━━━━━━  
四十一、音视频弱网测试  
━━━━━━━━━━━━━━━━━━━━

模拟：

高延迟

高抖动

低带宽

丢包

乱序

临时断网

网络恢复

Wi-Fi → 4G/5G

4G/5G → Wi-Fi

VPN 切换

网络接口切换

至少关注：

RTT

packet loss

jitter

bitrate

frame rate

resolution

audio concealment

connection state

测试系统是否：

自动恢复

ICE Restart

重新协商

或者合理结束通话。

━━━━━━━━━━━━━━━━━━━━  
四十二、音视频断线重连  
━━━━━━━━━━━━━━━━━━━━

测试：

断网 1 秒

断网 5 秒

断网 10 秒

断网后恢复

信令恢复但媒体未恢复

媒体恢复但 WebSocket 未恢复

ICE disconnected → connected

ICE failed

重新创建 PeerConnection

检查：

是否出现两个 PeerConnection

是否重复播放音频

是否创建重复 Track

是否旧连接未释放。

━━━━━━━━━━━━━━━━━━━━  
四十三、音视频并发  
━━━━━━━━━━━━━━━━━━━━

测试：

用户 A 正在和 B 通话，C 呼叫 A

用户同时发起两个通话

双端同时发起 Call

重复 Accept

重复 Hangup

多个设备登录同一账号

PC 正在通话时手机接到呼叫

检查 Busy 状态和 Call Ownership。

━━━━━━━━━━━━━━━━━━━━  
四十四、多人音视频  
━━━━━━━━━━━━━━━━━━━━

如果支持多人房间：

测试：

2 人

3 人

5 人

10 人

根据项目能力增加。

测试：

中途加入

中途退出

Host 离开

成员断网

成员重连

成员静音

成员关闭摄像头

成员共享屏幕

多个成员同时操作

检查：

Participant List

Track Mapping

用户 ID 与 Stream 映射

不得发生音视频串流。

━━━━━━━━━━━━━━━━━━━━  
四十五、通话记录  
━━━━━━━━━━━━━━━━━━━━

测试：

未接听

已拒绝

已取消

已接听

正常结束

异常断开

通话时长

开始时间

结束时间

UTC / 时区

短于 1 秒

长时间通话

重复 hangup

检查通话记录不能被重复写入。

━━━━━━━━━━━━━━━━━━━━  
四十六、音视频资源泄漏  
━━━━━━━━━━━━━━━━━━━━

每次通话结束后验证：

RTCPeerConnection.close()

MediaStreamTrack.stop()

WebSocket Listener 移除

Timer 清理

ICE Timer 清理

MediaStream 释放

video.srcObject 清理

audio.srcObject 清理

事件监听器移除

重复进行：

10

50

100

次通话。

观察：

内存

摄像头占用

麦克风占用

PeerConnection 数量

EventListener 数量

Timer 数量

不能持续增长。

━━━━━━━━━━━━━━━━━━━━  
四十七、WebRTC Stats  
━━━━━━━━━━━━━━━━━━━━

如果可以访问 RTCPeerConnection.getStats()：

采集：

RTT

jitter

packetsLost

packetsReceived

packetsSent

bytesReceived

bytesSent

framesDecoded

framesDropped

framesPerSecond

audioLevel

availableOutgoingBitrate

currentRoundTripTime

用于识别：

高丢包

高延迟

严重掉帧

网络质量下降。

不要要求固定绝对值通过。

根据测试环境设置合理阈值。

━━━━━━━━━━━━━━━━━━━━  
四十八、音视频 E2E  
━━━━━━━━━━━━━━━━━━━━

建立至少两个独立 Browser Context。

模拟：

用户 A

用户 B

真实完成：

登录

A 呼叫 B

B 收到来电

B 接听

建立 PeerConnection

双方获得媒体

A mute

A unmute

A camera off

A camera on

B hangup

双方状态变成 ended

检查后台通话记录。

还要增加：

拒绝流程

取消流程

无人接听

忙线

弱网

断线重连。

━━━━━━━━━━━━━━━━━━━━  
四十九、音视频自动化环境限制  
━━━━━━━━━━━━━━━━━━━━

浏览器自动化环境可以使用测试媒体设备，例如 Chromium：

--use-fake-device-for-media-stream

--use-fake-ui-for-media-stream

允许使用测试音频/视频文件模拟设备。

但：

业务逻辑、信令服务器、PeerConnection 建立、SDP/ICE 流程应尽量真实。

不要 Mock 整个 WebRTC 流程然后宣称音视频已测试成功。

对于必须依赖真实摄像头、真实麦克风、真实 NAT/TURN 的测试：

标记：

hardware

network

manual

integration

并单独提供运行命令。

━━━━━━━━━━━━━━━━━━━━  
五十、安全测试  
━━━━━━━━━━━━━━━━━━━━

测试：

XSS  
SQL Injection  
NoSQL Injection  
Command Injection  
SSRF  
Path Traversal  
CSRF  
Open Redirect  
IDOR  
JWT Manipulation  
Header Injection  
Cookie Manipulation  
非法 Host  
超长 Header  
超大 Body

音视频额外检查：

用户是否可以加入无权限 RTC Room

用户 A 是否可以监听用户 B/C 的 Room

伪造 callId

伪造 roomId

伪造 participantId

未授权获取 TURN Credential

TURN Credential 是否永久有效

信令消息是否校验发送者身份。

日志中禁止泄漏：

API Key  
Password  
Token  
JWT  
Cookie  
Authorization Header  
数据库密码  
第三方密钥  
TURN 密码。

━━━━━━━━━━━━━━━━━━━━  
五十一、Frontend Component Test  
━━━━━━━━━━━━━━━━━━━━

重要 UI 测试：

正常 Render  
Loading  
Empty State  
Error State  
Disabled  
点击  
双击  
连续点击  
输入  
提交  
重复提交  
API 慢  
API 错误  
长文本  
emoji  
中文  
大量列表  
图片失败

音视频 UI：

来电弹窗

拨号页面

连接中

通话中

断线重连

麦克风开关

摄像头开关

扬声器状态

屏幕共享

挂断按钮

通话时长

忙线

拒绝

取消

权限错误。

━━━━━━━━━━━━━━━━━━━━  
五十二、E2E  
━━━━━━━━━━━━━━━━━━━━

使用 Playwright 或项目当前 E2E 框架。

覆盖真实用户流程：

注册  
登录  
创建  
查看  
编辑  
删除  
搜索  
分页  
聊天  
音视频呼叫  
刷新  
重新登录  
退出登录  
异常处理

至少建立：

happy-path.spec

auth.spec

permission.spec

error.spec

edge-case.spec

network.spec

call.spec

webrtc.spec

━━━━━━━━━━━━━━━━━━━━  
五十三、浏览器网络异常  
━━━━━━━━━━━━━━━━━━━━

E2E 模拟：

Offline  
Slow Network  
Timeout  
429  
500  
502  
503  
错误 JSON  
连接突然断开  
请求长时间 Pending  
Refresh  
Back  
Forward  
快速切 Tab  
快速点击按钮

━━━━━━━━━━━━━━━━━━━━  
五十四、Responsive Test  
━━━━━━━━━━━━━━━━━━━━

至少测试：

320x568  
375x667  
390x844  
768x1024  
1024x768  
1366x768  
1440x900  
1920x1080

检查：

Horizontal Scroll  
Overflow  
Modal 超出屏幕  
Button 被遮挡  
文字溢出  
Layout Shift

音视频页面额外检查：

远端视频

本地小窗

多人 Grid

通话按钮

横屏

竖屏。

━━━━━━━━━━━━━━━━━━━━  
五十五、并发测试  
━━━━━━━━━━━━━━━━━━━━

关键接口测试：

2  
10  
50  
100

并发。

优先：

Create  
Update  
Delete  
Send Message  
WebSocket  
Call Invite  
Call Accept  
Call Hangup  
Agent Run  
Login  
Upload

检查：

Race Condition  
Lost Update  
Duplicate Record  
Duplicate Message  
Duplicate Call  
Deadlock  
状态覆盖

━━━━━━━━━━━━━━━━━━━━  
五十六、幂等性  
━━━━━━━━━━━━━━━━━━━━

同一个请求：

2 次  
10 次  
50 次

检查：

是否重复创建  
是否重复发送  
是否重复扣费  
是否重复任务  
是否重复 Tool  
是否重复 Message  
是否重复创建 RTC Session  
是否重复创建通话记录。

━━━━━━━━━━━━━━━━━━━━  
五十七、状态机  
━━━━━━━━━━━━━━━━━━━━

针对：

pending  
running  
success  
failed  
cancelled  
deleted

以及通话状态：

calling  
ringing  
connecting  
connected  
reconnecting  
ended  
rejected  
busy  
timeout

主动尝试非法状态跳转。

后端必须真正拒绝非法转换。

━━━━━━━━━━━━━━━━━━━━  
五十八、时间  
━━━━━━━━━━━━━━━━━━━━

测试：

UTC  
UTC+8  
UTC+9  
DST  
跨天  
跨月  
跨年  
闰年  
Token Expiry  
Cache Expiry  
Session Expiry  
Call Duration

不要依赖开发者本机时区。

━━━━━━━━━━━━━━━━━━━━  
五十九、异常恢复  
━━━━━━━━━━━━━━━━━━━━

测试：

Database Down  
Redis Down  
Vector DB Down  
LLM Down  
External API Down  
WebSocket Down  
SSE Down  
TURN Down  
STUN Down  
Signaling Down  
Network Down  
DNS Error  
Connection Refused  
Connection Reset

系统不得出现：

无限 Retry  
死循环  
进程 Crash  
资源泄漏  
永久 Loading。

━━━━━━━━━━━━━━━━━━━━  
六十、资源泄漏  
━━━━━━━━━━━━━━━━━━━━

重复执行：

100  
500  
1000

次适合自动化的操作。

观察：

Memory  
CPU  
DB Connection  
HTTP Connection  
WebSocket  
RTCPeerConnection  
MediaStreamTrack  
Timer  
Event Listener  
goroutine  
Promise  
AbortController

检查是否持续增长。

━━━━━━━━━━━━━━━━━━━━  
六十一、Property-Based Test  
━━━━━━━━━━━━━━━━━━━━

对纯函数和 Parser 使用 Property-Based Testing。

自动生成：

随机字符串  
随机 Unicode  
随机数字  
随机 JSON  
随机数组  
随机嵌套结构  
随机 RTC signaling payload

寻找开发者没有想到的边界条件。

━━━━━━━━━━━━━━━━━━━━  
六十二、Fuzz Test  
━━━━━━━━━━━━━━━━━━━━

对：

Parser  
JSON Parser  
Protocol Transformer  
SSE Parser  
WebSocket Message  
API Body  
Tool Arguments  
WebRTC Signaling Payload  
SDP Parser

进行 Fuzz。

随机输入不能导致：

Process Crash  
Panic  
Unhandled Promise Rejection  
无限循环  
内存爆炸。

━━━━━━━━━━━━━━━━━━━━  
六十三、性能测试  
━━━━━━━━━━━━━━━━━━━━

测试并记录：

P50  
P90  
P95  
P99  
RPS  
Error Rate  
CPU  
Memory  
DB Connections

至少：

1 concurrent user  
10 concurrent users  
50 concurrent users  
100 concurrent users

音视频性能另外记录：

同时 RTC Connection 数

信令吞吐

建立通话耗时

ICE Connection Time

Call Setup Time

内存占用

CPU 占用

不要使用大量真实付费 LLM 请求进行系统性能压测。

━━━━━━━━━━━━━━━━━━━━  
六十四、测试代码质量  
━━━━━━━━━━━━━━━━━━━━

测试代码必须：

清晰  
可维护  
可重复  
独立  
尽量无随机失败  
避免硬编码时间  
避免依赖测试顺序

禁止：

assert true

catch {}

空断言

无意义 Snapshot

为了 Coverage 而 Coverage。

━━━━━━━━━━━━━━━━━━━━  
六十五、禁止通过以下方式让测试变绿  
━━━━━━━━━━━━━━━━━━━━

禁止：

删除失败测试

skip 真正存在问题的测试

降低断言强度

直接 catch 异常忽略

为了测试通过修改正确业务逻辑

把真实失败改成固定 Mock

隐藏错误

强行返回 success。

如果确实因为：

缺少 API Key

缺少摄像头

缺少麦克风

缺少 TURN 环境

CI 不支持真实媒体设备

导致测试无法运行，可以标记为：

SKIPPED

但必须明确原因。

━━━━━━━━━━━━━━━━━━━━  
六十六、Bug 修复流程  
━━━━━━━━━━━━━━━━━━━━

发现业务 Bug：

第一步：

写稳定失败测试。

第二步：

运行确认：

FAIL。

第三步：

分析根因。

第四步：

最小化修改业务代码。

第五步：

重新运行。

确认：

PASS。

第六步：

执行相关回归测试。

━━━━━━━━━━━━━━━━━━━━  
六十七、Coverage  
━━━━━━━━━━━━━━━━━━━━

生成覆盖率报告。

重点关注：

核心业务逻辑  
Auth  
权限  
数据库  
Agent  
LLM  
WebSocket  
SSE  
WebRTC Signaling  
RTC 状态机  
Streaming  
缓存

目标：

核心业务 >= 90%

高风险模块 >= 80%

普通模块 >= 70%

不要为了达到数字写无意义测试。

━━━━━━━━━━━━━━━━━━━━  
六十八、测试命令  
━━━━━━━━━━━━━━━━━━━━

根据当前技术栈建立统一命令。

Node：

npm run test  
npm run test:unit  
npm run test:integration  
npm run test:e2e  
npm run test:rtc  
npm run test:webrtc  
npm run test:llm  
npm run test:agent  
npm run test:security  
npm run test:coverage  
npm run test:all

pnpm 项目使用对应 pnpm 命令。

Go：

go test ./...

go test -race ./...

go test -cover ./...

Python：

pytest

pytest -v

pytest --cov

━━━━━━━━━━━━━━━━━━━━  
六十九、CI  
━━━━━━━━━━━━━━━━━━━━

如果项目使用 GitHub Actions：

PR 默认执行：

lint  
typecheck  
unit  
integration  
build

根据运行条件增加：

WebSocket  
WebRTC Signaling  
E2E

以下可以单独执行：

真实硬件 RTC 测试

TURN/NAT 测试

真实 LLM API 测试

性能测试

长时间压力测试。

━━━━━━━━━━━━━━━━━━━━  
七十、最终完整验证  
━━━━━━━━━━━━━━━━━━━━

所有测试完成以后实际运行：

lint  
typecheck  
unit tests  
integration tests  
database tests  
API tests  
auth tests  
WebSocket tests  
SSE tests  
WebRTC signaling tests  
RTC tests  
LLM tests  
Agent tests  
E2E  
build  
coverage

不要只生成代码而不执行。

━━━━━━━━━━━━━━━━━━━━  
七十一、最终报告  
━━━━━━━━━━━━━━━━━━━━

输出：

TEST SUMMARY

Unit Tests:  
总数  
通过  
失败  
跳过

Integration Tests:  
总数  
通过  
失败  
跳过

API Tests:  
总数  
通过  
失败

WebSocket Tests:  
总数  
通过  
失败

WebRTC Tests:  
总数  
通过  
失败  
跳过

Audio/Video Tests:  
总数  
通过  
失败  
因为设备/环境限制跳过数量

E2E Tests:  
总数  
通过  
失败

LLM Tests:  
总数  
通过  
失败  
因为缺少 API Key 跳过数量

Agent Tests:  
总数  
通过  
失败

Coverage:

Lines  
Functions  
Branches  
Statements

Performance:

P50  
P90  
P95  
P99  
Error Rate

RTC Performance:

Call Setup Time  
ICE Connection Time  
Reconnect Time  
Packet Loss  
Jitter  
RTT

同时统计：

P0 Bug 数量  
P1 Bug 数量  
P2 Bug 数量  
P3 Bug 数量

━━━━━━━━━━━━━━━━━━━━  
七十二、每个 Bug 报告  
━━━━━━━━━━━━━━━━━━━━

每个 Bug 必须给：

标题  
严重程度  
文件  
函数  
行号  
触发条件  
复现步骤  
实际结果  
预期结果  
根因  
修复方案  
对应测试文件  
是否已经修复

━━━━━━━━━━━━━━━━━━━━  
七十三、最后总结  
━━━━━━━━━━━━━━━━━━━━

最终明确回答：

1. 哪些模块测试已经比较完整。

2. 哪些模块仍然测试不足。

3. 哪些测试因为外部服务暂时无法执行。

4. 哪些真实 LLM 测试因为缺少 API Key 被跳过。

5. 哪些 RTC 测试因为缺少设备、TURN、NAT 或浏览器环境被跳过。

6. 是否存在阻塞上线的问题。

7. 最危险的 5 个模块。

8. 最可能发生生产事故的 5 个场景。

9. 当前测试体系是否适合加入 CI/CD。

10. 是否存在测试数据没有被清理。

11. 是否存在通话 Session / Room / RTC 数据残留。

12. 是否存在 PeerConnection、MediaStreamTrack、WebSocket 或 Timer 未释放。

最后额外执行一次测试数据扫描。

搜索：

test_run_id

source=automated_test

test:

tests/

RTC test session

确认没有本次运行产生的垃圾数据残留。

如果发现：

数据库测试数据

Redis Key

对象存储文件

向量数据

通话记录

RTC Session

测试 Room

临时文件

立即执行安全 cleanup。

只能删除本次测试产生的数据。

━━━━━━━━━━━━━━━━━━━━  
最终原则  
━━━━━━━━━━━━━━━━━━━━

不要假设项目当前实现正确。

不要因为已有测试全部通过就停止。

主动寻找开发者没有考虑到的异常情况。

尤其重点检查：

边界输入

并发

客户端中断

上游异常

SSE 断流

WebSocket 重连

WebRTC 信令丢失

ICE 失败

TURN 不可用

音视频设备切换

媒体权限拒绝

弱网

通话重连

通话状态机

媒体资源泄漏

重复呼叫

重复接听

重复挂断

RTC 串线

Agent 无限循环

LLM 空响应

LLM 只输出少量 Token 后结束

数据库部分写入

缓存状态不一致

权限越权

测试数据污染。

优先验证真实行为，而不是为了让测试数量看起来很多而编写大量低价值测试。

执行顺序建议：

unit  
→ integration  
→ database  
→ API  
→ auth  
→ WebSocket  
→ SSE  
→ WebRTC signaling  
→ 音视频  
→ LLM  
→ Agent  
→ E2E  
→ security  
→ concurrency  
→ performance

不要一次性生成全部测试代码。

每完成一个测试模块立即运行。

如果失败：

先判断是测试代码错误还是业务 Bug。

确认测试模块稳定以后，再进入下一个模块。
