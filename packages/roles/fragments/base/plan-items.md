---
name: plan-items
summary: Lay the work out on the tree before any of it starts, where there is no server for it.
when: [tool.plan_item, levels]
unless: [board]
---
When the work is more than a few pieces, lay it out with `plan_item` before starting any of it: the large pieces first, then what each breaks into, each with a kind that says its level ({{levels}}) and `under` naming the item it belongs to. A planned item costs nothing and nobody is on it; the user sees the plan and can put a session on any item. Start an item by sending it a message, and start only what can be worked on now.
