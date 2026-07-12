const test = require("node:test");
const assert = require("node:assert/strict");
const { once } = require("node:events");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");

const { createTestLocalLeafServer } = require("./helpers/localleaf-test-server");

async function startTestServer(projectRoot) {
  const app = createTestLocalLeafServer({ port: 0, projectRoot, autoStartTunnel: false });
  app.server.listen(0);
  await once(app.server, "listening");
  app.state.port = app.server.address().port;
  return {
    app,
    baseUrl: `http://localhost:${app.state.port}`,
    hostToken: app.state.hostToken
  };
}

async function postNewProject(server, body, includeBody = true) {
  const response = await fetch(`${server.baseUrl}/api/project/new`, {
    method: "POST",
    headers: {
      "content-type": "application/json",
      "x-localleaf-host-token": server.hostToken
    },
    body: includeBody ? JSON.stringify(body) : undefined
  });
  const payload = JSON.parse(await response.text());
  return { response, payload };
}

function makeInitialProject(root) {
  fs.writeFileSync(
    path.join(root, "main.tex"),
    "\\documentclass{article}\\begin{document}Initial\\end{document}",
    "utf8"
  );
}

test("new project keeps the default destination and name when no options are sent", async () => {
  const previousProjectsDir = process.env.LOCALLEAF_PROJECTS_DIR;
  const workspace = fs.mkdtempSync(path.join(os.tmpdir(), "localleaf-new-project-default-"));
  const initialRoot = path.join(workspace, "initial");
  const projectsRoot = path.join(workspace, "projects");
  fs.mkdirSync(initialRoot);
  makeInitialProject(initialRoot);
  process.env.LOCALLEAF_PROJECTS_DIR = projectsRoot;
  const server = await startTestServer(initialRoot);

  try {
    const created = await postNewProject(server, undefined, false);
    assert.equal(created.response.status, 200);
    assert.equal(created.payload.project.name, "LocalLeaf Project");
    assert.equal(created.payload.project.defaultProjectsDirectory, projectsRoot);
    assert.equal(path.resolve(created.payload.project.root), path.join(projectsRoot, "LocalLeaf Project"));
    assert.equal(fs.existsSync(path.join(created.payload.project.root, "main.tex")), true);

    const anonymousStateResponse = await fetch(`${server.baseUrl}/api/state`);
    const anonymousState = await anonymousStateResponse.json();
    assert.equal(anonymousState.project.defaultProjectsDirectory, undefined);

    const second = await postNewProject(server, {});
    assert.equal(second.response.status, 200);
    assert.equal(second.payload.project.name, "LocalLeaf Project 2");
  } finally {
    await server.app.stop();
    fs.rmSync(workspace, { recursive: true, force: true });
    if (previousProjectsDir === undefined) delete process.env.LOCALLEAF_PROJECTS_DIR;
    else process.env.LOCALLEAF_PROJECTS_DIR = previousProjectsDir;
  }
});

test("new project uses an explicit destination and never overwrites an existing folder", async () => {
  const workspace = fs.mkdtempSync(path.join(os.tmpdir(), "localleaf-new-project-custom-"));
  const initialRoot = path.join(workspace, "initial");
  const destination = path.join(workspace, "chosen destination");
  const occupiedRoot = path.join(destination, "Research Notes");
  fs.mkdirSync(initialRoot);
  fs.mkdirSync(occupiedRoot, { recursive: true });
  makeInitialProject(initialRoot);
  fs.writeFileSync(path.join(occupiedRoot, "keep.txt"), "do not replace", "utf8");
  const server = await startTestServer(initialRoot);

  try {
    const created = await postNewProject(server, {
      projectName: "Research Notes",
      destinationDirectory: destination
    });
    assert.equal(created.response.status, 200);
    assert.equal(created.payload.project.name, "Research Notes 2");
    assert.equal(path.resolve(created.payload.project.root), path.join(destination, "Research Notes 2"));
    assert.equal(fs.readFileSync(path.join(occupiedRoot, "keep.txt"), "utf8"), "do not replace");

    const second = await postNewProject(server, {
      projectName: "Research Notes",
      destinationDirectory: destination
    });
    assert.equal(second.response.status, 200);
    assert.equal(second.payload.project.name, "Research Notes 3");
    assert.equal(fs.existsSync(path.join(destination, "Research Notes 3", "main.tex")), true);
  } finally {
    await server.app.stop();
    fs.rmSync(workspace, { recursive: true, force: true });
  }
});

test("new project rejects unsafe names and invalid destination paths without switching projects", async () => {
  const workspace = fs.mkdtempSync(path.join(os.tmpdir(), "localleaf-new-project-invalid-"));
  const initialRoot = path.join(workspace, "initial");
  const destination = path.join(workspace, "destination");
  const fileDestination = path.join(workspace, "not-a-folder.txt");
  fs.mkdirSync(initialRoot);
  fs.mkdirSync(destination);
  makeInitialProject(initialRoot);
  fs.writeFileSync(fileDestination, "file", "utf8");
  const server = await startTestServer(initialRoot);

  try {
    for (const projectName of ["", "../escape", "CON", "trailing.", "x".repeat(71)]) {
      const result = await postNewProject(server, { projectName, destinationDirectory: destination });
      assert.equal(result.response.status, 400, `expected ${JSON.stringify(projectName)} to be rejected`);
      assert.match(result.payload.error, /project name|choose a project name/i);
    }

    const invalidDestinations = [
      "relative/folder",
      path.join(workspace, "missing"),
      fileDestination,
      ""
    ];
    for (const destinationDirectory of invalidDestinations) {
      const result = await postNewProject(server, { projectName: "Safe name", destinationDirectory });
      assert.equal(result.response.status, 400, `expected ${JSON.stringify(destinationDirectory)} to be rejected`);
      assert.match(result.payload.error, /destination/i);
      assert.equal(result.payload.field, "destinationDirectory");
    }

    const stateResponse = await fetch(`${server.baseUrl}/api/state`, {
      headers: { "x-localleaf-host-token": server.hostToken }
    });
    const state = await stateResponse.json();
    assert.equal(path.resolve(state.project.root), initialRoot);
    assert.deepEqual(fs.readdirSync(destination), []);
  } finally {
    await server.app.stop();
    fs.rmSync(workspace, { recursive: true, force: true });
  }
});

test("new project retries are idempotent and conflicting request ID reuse creates no orphan", async () => {
  const workspace = fs.mkdtempSync(path.join(os.tmpdir(), "localleaf-new-project-idempotency-"));
  const initialRoot = path.join(workspace, "initial");
  const destination = path.join(workspace, "destination");
  fs.mkdirSync(initialRoot);
  fs.mkdirSync(destination);
  makeInitialProject(initialRoot);
  const server = await startTestServer(initialRoot);
  const body = {
    requestId: "create-retry-request-01",
    projectName: "Retry Safe Project",
    destinationDirectory: destination
  };

  try {
    const first = await postNewProject(server, body);
    assert.equal(first.response.status, 200);
    const firstRoot = path.resolve(first.payload.project.root);
    assert.equal(firstRoot, path.join(destination, "Retry Safe Project"));

    const replay = await postNewProject(server, body);
    assert.equal(replay.response.status, 200);
    assert.equal(path.resolve(replay.payload.project.root), firstRoot);
    assert.deepEqual(fs.readdirSync(destination).sort(), ["Retry Safe Project"]);
    assert.equal(fs.existsSync(path.join(destination, "Retry Safe Project 2")), false);

    const conflict = await postNewProject(server, {
      ...body,
      projectName: "Conflicting Project"
    });
    assert.equal(conflict.response.status, 409);
    assert.equal(conflict.payload.code, "PROJECT_CREATE_IDEMPOTENCY_CONFLICT");
    assert.equal(fs.existsSync(path.join(destination, "Conflicting Project")), false);
    assert.equal(fs.existsSync(path.join(destination, "Conflicting Project 2")), false);
    assert.deepEqual(fs.readdirSync(destination).sort(), ["Retry Safe Project"]);

    const stateResponse = await fetch(`${server.baseUrl}/api/state`, {
      headers: { "x-localleaf-host-token": server.hostToken }
    });
    const state = await stateResponse.json();
    assert.equal(path.resolve(state.project.root), firstRoot);
  } finally {
    await server.app.stop();
    fs.rmSync(workspace, { recursive: true, force: true });
  }
});

test("new project rejects network destinations with a structured field error and no active-project switch", async () => {
  const workspace = fs.mkdtempSync(path.join(os.tmpdir(), "localleaf-new-project-network-"));
  const initialRoot = path.join(workspace, "initial");
  const localDestination = path.join(workspace, "local destination");
  fs.mkdirSync(initialRoot);
  fs.mkdirSync(localDestination);
  makeInitialProject(initialRoot);
  const server = await startTestServer(initialRoot);

  try {
    for (const destinationDirectory of ["\\\\server\\share\\projects", "//server/share/projects"]) {
      const result = await postNewProject(server, {
        requestId: `network-path-${destinationDirectory.startsWith("//") ? "slash" : "unc"}`,
        projectName: "Network Project",
        destinationDirectory
      });
      assert.equal(result.response.status, 400, `${destinationDirectory} must be rejected on every platform`);
      assert.match(result.payload.error, /local destination folder|network path/i);
      assert.equal(result.payload.field, "destinationDirectory");

      const stateResponse = await fetch(`${server.baseUrl}/api/state`, {
        headers: { "x-localleaf-host-token": server.hostToken }
      });
      const state = await stateResponse.json();
      assert.equal(path.resolve(state.project.root), initialRoot);
    }

    assert.deepEqual(fs.readdirSync(localDestination), []);
    assert.equal(fs.existsSync(path.join(workspace, "Network Project")), false);
  } finally {
    await server.app.stop();
    fs.rmSync(workspace, { recursive: true, force: true });
  }
});

test("new project rejects the bundled starter template, its children, and linked aliases as destinations", async (t) => {
  const workspace = fs.mkdtempSync(path.join(os.tmpdir(), "localleaf-new-project-template-guard-"));
  const initialRoot = path.join(workspace, "initial");
  const linkedTemplate = path.join(workspace, "starter-template-link");
  const sampleProject = path.resolve(__dirname, "..", "samples", "thesis");
  const nonce = `${process.pid}-${Date.now()}`;
  const scenarios = [
    {
      label: "starter template root",
      projectName: `LocalLeaf Template Root Guard ${nonce}`,
      destinationDirectory: sampleProject,
      targetPath: path.join(sampleProject, `LocalLeaf Template Root Guard ${nonce}`)
    },
    {
      label: "starter template child",
      projectName: `LocalLeaf Template Child Guard ${nonce}`,
      destinationDirectory: path.join(sampleProject, "assets"),
      targetPath: path.join(sampleProject, "assets", `LocalLeaf Template Child Guard ${nonce}`)
    }
  ];
  const cleanupTargets = scenarios.map((scenario) => scenario.targetPath);
  fs.mkdirSync(initialRoot);
  makeInitialProject(initialRoot);

  try {
    fs.symlinkSync(sampleProject, linkedTemplate, process.platform === "win32" ? "junction" : "dir");
    const linkedProjectName = `LocalLeaf Template Link Guard ${nonce}`;
    const linkedTarget = path.join(sampleProject, linkedProjectName);
    scenarios.push({
      label: process.platform === "win32" ? "starter template junction" : "starter template symlink",
      projectName: linkedProjectName,
      destinationDirectory: linkedTemplate,
      targetPath: linkedTarget
    });
    cleanupTargets.push(linkedTarget);
  } catch (error) {
    if (!["EACCES", "EPERM", "ENOTSUP", "UNKNOWN"].includes(error?.code)) throw error;
    t.diagnostic(`Linked-directory case is unavailable on this platform (${error.code}).`);
  }

  const server = await startTestServer(initialRoot);
  try {
    for (const scenario of scenarios) {
      assert.equal(fs.existsSync(scenario.targetPath), false, `${scenario.label} target must start absent`);
      const result = await postNewProject(server, {
        projectName: scenario.projectName,
        destinationDirectory: scenario.destinationDirectory
      });
      assert.equal(result.response.status, 400, `${scenario.label} must be rejected`);
      assert.match(result.payload.error, /outside LocalLeaf's bundled starter template/i);
      assert.equal(result.payload.field, "destinationDirectory");
      assert.equal(fs.existsSync(scenario.targetPath), false, `${scenario.label} must not create a nested project`);

      const stateResponse = await fetch(`${server.baseUrl}/api/state`, {
        headers: { "x-localleaf-host-token": server.hostToken }
      });
      const state = await stateResponse.json();
      assert.equal(path.resolve(state.project.root), initialRoot, `${scenario.label} must not switch the active project`);
    }
  } finally {
    await server.app.stop();
    if (fs.existsSync(linkedTemplate)) fs.unlinkSync(linkedTemplate);
    for (const target of cleanupTargets) {
      if (fs.existsSync(target)) fs.rmSync(target, { recursive: true, force: true });
    }
    fs.rmSync(workspace, { recursive: true, force: true });
  }
});
