---
name: grill-me
description: 反向拷问：把一份计划/设计当成决策树，一次只问一个问题、每题附推荐答案，直到双方对同一个设计达成共识。用户说"先讨论""拷问我""grill me"时使用。
---

Interview me relentlessly about every aspect of this plan until we reach a shared understanding. Walk down each branch of the design tree, resolving dependencies between decisions one-by-one. For each question, provide your recommended answer. Ask the questions one at a time. If a question can be answered by exploring the codebase, explore the codebase instead.

---

（以下为本项目的接线说明，不属于原版技能内容）

**什么时候会用到它**：`ask` 工具在技术选型分叉点上提问时，用户可能选择「保留选项，先讨论」——
那一刻起进入本技能的模式，直到把分叉点重新抛回给用户拍板。

**这个项目里，讨论的起点是这三件事**（逐条问，不要合并成一段）：

1. 目前遭遇的问题是什么？
2. 需要思考的矛盾点是什么？
3. 抉择的对象是什么？

**四条落地要求**：

- **一次只问一个问题**。一次甩十个问题是这个技能最容易走样的地方——用户的工作记忆会被塞满，每个回答的质量都下降。
- **每题都给出你的推荐答案与理由**。只提问不给立场，用户会疲于应付；给了立场，他往往只需说"嗯"或"不"。
- **能自己查的别问**。候选方案的事实部分（项目里已经在用什么、有没有这个依赖、现有代码怎么写的）用 read/grep/ls 自己确认——问用户已知的事实是在浪费他的时间。
- **收口后必须把分叉点抛回去**。讨论不是目的；讨论完要让用户拍板（再次调用 `ask`，或直接在回复里列清方案与取舍请他选）。用户明确说"你定"时才代替他定，并写明你替他定了什么、依据是什么。
