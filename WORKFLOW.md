# GitHub Development Workflow

This document outlines the standard Git and GitHub workflow for the **EpicSyncCal** browser extension, specifically tailored for collaborating with an AI coding assistant.

## The "Golden Rule" of Our Workflow
**Always maintain a clean `main` branch that works.**

Going forward, whenever we want to add a new feature or fix a bug, we will follow this loop:

### 1. Branching (For New Features)
Before we make any major code changes to the extension, ask me to create a new branch.
*   **Prompt Example:** *"Let's add a feature to color-code calendar events. Start a new branch for this."*
*   **What I will do:** `git checkout -b feature/color-coding`

### 2. Developing & Iterating
We will write code, test the extension locally via `chrome://extensions`, and iterate. As we reach stable milestones (even if the feature isn't fully complete), I can save our progress.
*   **Prompt Example:** *"This looks good so far, let's commit these changes."*
*   **What I will do:**
    ```bash
    git add .
    git commit -m "Implement basic color coding logic"
    ```

### 3. Reviewing & Merging
Once the feature is fully tested and working perfectly in Chrome, we will merge it back into the `main` branch and push it to GitHub so your remote repository is updated.
*   **Prompt Example:** *"The color-coding is perfect. Let's merge this and push to GitHub."*
*   **What I will do:**
    ```bash
    git checkout main
    git merge feature/color-coding
    git push origin main
    ```

### 4. Quick Fixes (Direct to Main)
If we are just fixing a tiny typo or making a small CSS tweak, we don't necessarily need a full branch. We can just edit and push directly.
*   **Prompt Example:** *"I fixed a typo in the popup, please push it up."*
*   **What I will do:** `git add . && git commit -m "Fix typo" && git push`

---

## Useful Git Commands You Can Run Locally

If you ever want to interact with Git yourself using your Mac Terminal:

*   **See what files have changed:** `git status`
*   **See the history of our saves:** `git log --oneline`
*   **Undo your local unsaved changes and revert to the last commit:** `git checkout -- .` (Warning: deletes unsaved work)
