#!/usr/bin/env node
// Packs this extension and proves the tarball is actually loadable.
//
// `files` is a hand-maintained allow-list, so a new module is one forgotten line
// away from being absent from the published artifact. The working tree always
// has the file, so tests never catch it, and after publish it is unfixable
// except by burning a version number.
//
// Pack, extract, then walk the real import graph from the entry points and
// require every hop to exist inside the tarball. Bare specifiers are checked
// against the manifest's own dependency lists.
import { execFileSync, execSync } from "node:child_process";
import { existsSync, mkdtempSync, readFileSync, rmSync, statSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, relative, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const manifest = JSON.parse(readFileSync(join(ROOT, "package.json"), "utf8"));
const allowedBare = new Set([
	...Object.keys(manifest.dependencies ?? {}),
	...Object.keys(manifest.peerDependencies ?? {}),
]);

const work = mkdtempSync(join(tmpdir(), "pack-verify-"));
const failures = [];
try {
	// execSync, not execFileSync: on Windows npm is a .cmd shim, which recent Node
	// refuses to spawn without a shell. Every argument is a literal except the
	// quoted temp path.
	const tarball = execSync(`npm pack --pack-destination "${work}" --silent`, {
		cwd: ROOT,
		encoding: "utf8",
	})
		.trim()
		.split("\n")
		.pop()
		.trim();
	execFileSync("tar", ["-xzf", join(work, tarball), "-C", work], { stdio: "inherit" });
	const shipped = join(work, "package");

	const entries = new Set(manifest.pi?.extensions ?? []);
	for (const target of Object.values(manifest.exports ?? {})) {
		if (typeof target === "string") entries.add(target);
	}
	if (manifest.main) entries.add(manifest.main);

	// TypeScript under Node16 resolution imports "./foo.js" while the shipped
	// module is foo.ts, so that rewrite is tried first. A bare "./x" naming a
	// directory must fall through to ./x.ts then ./x/index.ts, hence the isFile
	// check rather than mere existence.
	const resolveSpec = (fromFile, spec) => {
		const base = resolve(dirname(fromFile), spec);
		const candidates = [];
		if (/\.(js|mjs|cjs)$/.test(base)) {
			candidates.push(base.replace(/\.js$/, ".ts").replace(/\.mjs$/, ".mts").replace(/\.cjs$/, ".cts"));
		}
		candidates.push(base, `${base}.ts`, join(base, "index.ts"));
		return candidates.find((c) => existsSync(c) && statSync(c).isFile()) ?? null;
	};

	const seen = new Set();
	const queue = [];
	for (const e of entries) {
		const f = resolve(shipped, e);
		if (!existsSync(f)) {
			failures.push(`entry point missing from tarball: ${e}`);
			continue;
		}
		queue.push(f);
	}
	while (queue.length > 0) {
		const file = queue.pop();
		if (seen.has(file)) continue;
		seen.add(file);
		const src = readFileSync(file, "utf8");
		const specs = [
			...src.matchAll(/(?:^|[\s;}])(?:import|export)\s[^;]*?from\s*["']([^"']+)["']/g),
			...src.matchAll(/\bimport\(\s*["']([^"']+)["']\s*\)/g),
		].map((m) => m[1]);
		for (const spec of specs) {
			if (spec.startsWith("node:")) continue;
			if (spec.startsWith(".")) {
				const target = resolveSpec(file, spec);
				if (!target) {
					failures.push(`${relative(shipped, file)} imports "${spec}", which is NOT in the tarball`);
					continue;
				}
				queue.push(target);
				continue;
			}
			const name = spec.startsWith("@") ? spec.split("/").slice(0, 2).join("/") : spec.split("/")[0];
			if (!allowedBare.has(name)) {
				failures.push(`${relative(shipped, file)} imports "${spec}", but ${name} is in neither dependencies nor peerDependencies`);
			}
		}
	}
	console.log(`packed ${tarball}`);
	console.log(`reachable modules verified: ${seen.size}`);
} finally {
	rmSync(work, { recursive: true, force: true });
}

if (failures.length > 0) {
	console.error(`\n${failures.length} problem(s) would ship in this tarball:`);
	for (const f of [...new Set(failures)]) console.error(`  - ${f}`);
	process.exit(1);
}
console.log("tarball is self-contained");
