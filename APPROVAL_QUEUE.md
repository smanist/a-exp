Coordination file for autonomous agent sessions requiring human decisions.

# Approval Queue

Items requiring human decision before autonomous execution can proceed. Agents append to "Pending"; humans resolve by moving items to "Resolved" with a decision.

## Pending

## Resolved

<!--
Schema for pending items:

### YYYY-MM-DD — <title>
Project: <project name>
Type: resource | structural | external | tool-access | burst
Request: <what the agent wants to do>
Context: <why, with links to relevant log entries>
Options: <if applicable, what choices exist>
Estimated cost: <if resource type>

Schema for resolved items:

### YYYY-MM-DD — <title>
Decision: approved | denied | modified
By: <human>
Date: <YYYY-MM-DD>
Notes: <any modifications or context>
-->
