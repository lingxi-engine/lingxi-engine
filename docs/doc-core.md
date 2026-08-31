# 妯″潡鏂囨。锛欰I 鏍稿績锛坉oc-core锛?
> 瑕嗙洊锛歚src/core/` 鍏ㄩ儴 44 涓ā鍧?锝?瀵瑰簲浠ｇ爜閲忥細~11,000 琛?> 鏇存柊锛?026-08-29 锝?鏈枃妗ｆ寜瀛愮郴缁熷垎缁勶紝鏀瑰摢涓瓙绯荤粺鐪嬪摢鑺?
---

## 1. 瀛愮郴缁熷湴鍥?
### 1.1 娑堟伅缂栨帓锛堣亰澶╀富閾捐矾锛岃瑙?doc-chat.md锛?| 鏂囦欢 | 鑱岃矗 |
|------|------|
| router.ts (65KB鈿狅笍) | MessageRouter锛氭ā鍨嬮€夋嫨/澶?AI 缂栨帓 |
| ws-handler.ts (34KB) | WS 娑堟伅鍏ュ彛銆佽闃呫€乸rocessUserMessage |
| chat-modes.ts | 7 绉嶅崗浣滄ā寮忓垎鍙?|
| debate.ts | 杈╄妯″紡 |
| orchestrator.ts | 缂栨帓鍣?|

### 1.2 鐩爣涓庤嚜涓昏涓猴紙AGI 璺嚎锛?| 鏂囦欢 | 鑱岃矗 |
|------|------|
| goal-executor.ts (25KB) | 鐩爣鎵ц鍣細鎷嗚В鈫掓墽琛屸啋姹囨姤 |
| goal-tracker.ts | 鐩爣杩借釜锛堝惈鐙珛寤鸿〃 initGoalTrackerTable锛?|
| task-store.ts | 浠诲姟瀛樺偍 |
| thought-tree.ts | 鎬濈淮鏍?|
| dreamer.ts | 绂荤嚎"鍋氭ⅵ"锛堣嚜涓绘€濊€冿級 |
| dreamer 鐩稿叧锛歰utcome-tracker.ts | 鎵ц缁撴灉杩借釜 |
| clarifier.ts | 妯＄硦闇€姹傛緞娓?|
| critic.ts (12.7KB) | 鑷垜鎵瑰垽 |
| evaluator.ts | 缁撴灉璇勪及 |
| steer.ts | 杩愯涓浆鍚戝共棰?|
| entity-extractor.ts | 瀹炰綋鎶藉彇 |
| world-model.ts | 涓栫晫妯″瀷 |

### 1.3 璁板繂绯荤粺
| 鏂囦欢 | 鑱岃矗 |
|------|------|
| memory-search.ts | 璁板繂妫€绱?|
| memory-reflector.ts | 璁板繂鍙嶆€濓紙娌夋穩锛?|
| memory-decay.ts | 璁板繂琛板噺 |
| rag-engine.ts (15KB) | RAG 妫€绱㈠寮?|
| compaction.ts | 涓婁笅鏂囧帇缂?|
| context-roller.ts | 涓婁笅鏂囨粴鍔?|
| personality.ts | 浜烘牸璁惧畾 |

### 1.4 鎵ц涓庡畨鍏?| 鏂囦欢 | 鑱岃矗 |
|------|------|
| sandbox.ts | 鍛戒护娌欑锛堟湰鍦帮級 |
| docker-sandbox.ts (10.7KB) | Docker 闅旂鎵ц |
| approval.ts (8.4KB) | ApprovalManager锛氬啓鎿嶄綔瀹℃壒娴?|
| watchdog.ts | 鐪嬮棬鐙楋紙鍗℃妫€娴嬶級 |
| hooks.ts | 鐢熷懡鍛ㄦ湡閽╁瓙 |
| plugin-manager.ts | 鎻掍欢绠＄悊锛坧lugins/ 涓嬫湁鍙︿竴浠斤紝鈿狅笍 鍙岃優鑳庡緟鍚堝苟锛?|

### 1.5 澶氬疄渚嬩笌璋冨害
| 鏂囦欢 | 鑱岃矗 |
|------|------|
| instance-mesh.ts | 澶氬疄渚嬬粍缃戯紙peer 娑堟伅/浠诲姟锛?|
| cron-scheduler.ts (9.8KB) | 瀹氭椂浠诲姟锛坈reateCronJob锛?|
| subagent-manager.ts (29.9KB) | 瀛愪唬鐞嗭紙delegate_task 鐨勫悗绔級 |
| team-manager.ts | 鍥㈤槦绠＄悊 |
| inbox.ts | 绔欏唴鏀朵欢绠?|
| push.ts | Web Push 鎺ㄩ€?|
| timezone.ts | 鏃跺尯澶勭悊 |

### 1.6 鍩虹璁炬柦
| 鏂囦欢 | 鑱岃矗 |
|------|------|
| logger.ts | 鏃ュ織 |
| usage-tracker.ts | 鐢ㄩ噺缁熻锛坲sage.json 1.3MB 灏辨槸瀹冨啓鐨勶級 |
| session-manager.ts | 浼氳瘽绠＄悊 |
| search-providers.ts (13.3KB) | 鎼滅储婧愶紙tools/ 涓嬫湁杩戜技鍓湰 鈿狅笍锛?|
| types.ts | core 鍏变韩绫诲瀷 |

## 2. 璺ㄦā鍧楄鍒?
1. **ESM 鍔犺浇椤哄簭鏁忔劅**锛歞b.ts 蹇呴』鏈€鍏堝姞杞斤紙瑙?ARCHITECTURE 搂4锛夛紝
   鏂板 core 妯″潡椤跺眰 import 鏃舵敞鎰忎笉瑕佸紩鍏ュ惊鐜緷璧?2. **瀛愪唬鐞嗘ā寮?*锛氶暱浠诲姟璧?subagent-manager 娲剧敓锛屼笉瑕佸湪涓绘秷鎭惊鐜噷闃诲
3. **瀹℃壒娴?*锛氫换浣曞啓鎿嶄綔绫诲伐鍏凤紙鎵ц鍛戒护/鏀规枃浠讹級鎺?approval.ts锛?   涓嶈缁曡繃鐩存帴鎵ц
4. **鎼滅储婧愬弻鑳炶儙**锛歝ore/search-providers.ts 涓?tools/search-providers.ts
   骞跺瓨锛屾敼鎼滅储閫昏緫鍏堢‘璁?AI 鑱婂ぉ鐢ㄧ殑鏄摢浠斤紙setSearchManager 娉ㄥ叆鐨勬槸
   tools 鐗堬級锛宑ore 鐗堢敤閫斿緟鏌ワ紝**鍒彧鏀逛竴浠?*

## 3. 宸ㄧ煶鎷嗗垎璁″垝锛堟寜浼樺厛绾э級

1. router.ts锛?5KB锛夆啋 鎷?model-selector / multi-ai-orchestrator / prompt-builder
2. ws-handler.ts锛?4KB锛夆啋 鎷?ws-router / ws-push / message-pipeline
3. goal-executor.ts锛?5KB锛夆啋 鎷?goal-planner / goal-runner

鎷嗘硶涓庢牴 index.ts 鐩稿悓锛氭瘡鎷嗕竴涓窇鍏ㄩ噺 typecheck + 鍐掔儫锛岀豢浜嗗啀鎷嗕笅涓€涓€?
---

## 鍥炲綊娴嬭瘯娓呭崟锛堟敼 core 鍚庡繀璺戯級

- [ ] 鏅€氬璇濆線杩旀甯革紙鏈€鍩虹閾捐矾锛?- [ ] 瀛愪唬鐞嗕换鍔℃淳鐢?鍥炴敹姝ｅ父
- [ ] 瀹氭椂浠诲姟瑙﹀彂涓€娆℃垚鍔?- [ ] 璁板繂妫€绱細鏂板璇濊兘寮曠敤鍘嗗彶瑕佺偣
- [ ] 闀垮璇濆帇缂╁悗涓婁笅鏂囪繛璐?- [ ] 瀹℃壒娴侊細鍐欐搷浣滃伐鍏峰脊鍑哄鎵癸紝鎷掔粷鍚庝笉鎵ц
- [ ] watchdog锛氫汉涓烘寕璧蜂换鍔¤兘琚娴?- [ ] `npm run typecheck` 缁?
## 鍧戜綅璁板綍

### 2026-08-29锛堝缓妗ｏ級鍙岃優鑳庢枃浠舵竻鍗?- plugin-manager锛歝ore/ 涓?plugins/ 鍚勪竴浠?- search-providers锛歝ore/ 涓?tools/ 鍚勪竴浠?- 鏁欒锛?*鏀硅繖涓や釜鍔熻兘鍓嶅厛鐢?grep 纭 import 鏉ユ簮锛岄槻姝㈡敼浜嗘病琚紩鐢ㄧ殑閭ｄ唤**