import assert from "node:assert/strict";
import { test } from "node:test";
import { mainCheckoutRefusal } from "../shared/main-checkout.ts";

test("in the main checkout git only reads", () => {
	for (const ok of [
		"git status --porcelain",
		"git diff HEAD -- README.md && git log --oneline -5",
		"git -C ../repo show HEAD:package.json",
		"git --no-pager log -p",
		"git branch --list -vv",
		"git branch --show-current",
		"git worktree list --porcelain",
		"git rev-parse HEAD; git ls-files | wc -l",
		"pnpm test && echo done",
		"cat .gitignore",
	]) {
		assert.equal(mainCheckoutRefusal(ok), undefined, ok);
	}
	for (const refused of [
		"git commit -am wip",
		"git add README.md",
		"git stash",
		"git switch -c feat/x",
		"git checkout -- README.md",
		"git restore README.md",
		"git reset --hard",
		"git branch feat/new",
		"git worktree add ../x",
		"echo ok && git -C . commit -m x",
		"git status; git push",
		"git -c user.name=x commit --allow-empty -m probe",
	]) {
		assert.match(mainCheckoutRefusal(refused) ?? "", /git is read-only here/, refused);
	}
});
