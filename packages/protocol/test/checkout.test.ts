import { describe, expect, it } from "vitest";
import { mainCheckout } from "../src/index.ts";

describe("where a repository's main checkout is", () => {
	const never = (): string | undefined => {
		throw new Error("not asked: the git directory is in the checkout");
	};

	it("is the directory above the git directory, from the checkout itself and from any worktree of it", () => {
		expect(mainCheckout("/work/shop/.git", never)).toBe("/work/shop");
		expect(mainCheckout("/work/shop/.git/", never)).toBe("/work/shop");
		expect(mainCheckout("C:\\work\\shop\\.git", never)).toBe("C:\\work\\shop");
		expect(mainCheckout("/.git", never)).toBe("/");
	});

	it("is where a submodule's git directory says its checkout is, not a directory inside the outer repository's .git", () => {
		expect(mainCheckout("/work/shop/.git/modules/libs/pay", () => "/work/shop/libs/pay")).toBe("/work/shop/libs/pay");
	});

	it("is the directory a bare repository is in, which its worktrees share", () => {
		expect(mainCheckout("/work/shop.git", () => undefined)).toBe("/work");
		expect(mainCheckout("/work/shop.git", () => "")).toBe("/work");
	});
});
