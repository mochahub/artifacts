# Spike S4: workerd runner. Loader on :18090; the mock app's internal API on 127.0.0.1:18082.
using Workerd = import "/workerd/workerd.capnp";

const config :Workerd.Config = (
  v8Flags = ["--max-old-space-size=256"],
  services = [
    (name = "main", worker = .loader),
    (name = "datasvc", worker = .datasvc),
    (name = "logs", worker = .logs),
    (name = "app", external = (address = "127.0.0.1:18082", http = ())),
  ],
  sockets = [ (name = "http", address = "127.0.0.1:18090", http = (), service = "main") ],
);

const loader :Workerd.Worker = (
  modules = [ (name = "loader.js", esModule = embed "loader.js") ],
  compatibilityDate = "2026-10-01",
  bindings = [
    (name = "LOADER", workerLoader = (id = "artifacts")),
    (name = "APP", service = "app"),
    (name = "DATA_SVC", service = (name = "datasvc", entrypoint = "Data")),
    (name = "LOGS", service = "logs"),
    (name = "RUNNER_SECRET", fromEnvironment = "RUNNER_SECRET"),
  ],
  globalOutbound = "app",
);

const datasvc :Workerd.Worker = (
  modules = [ (name = "data.js", esModule = embed "data.js") ],
  compatibilityDate = "2026-10-01",
  bindings = [ (name = "APP", service = "app") ],
  globalOutbound = "app",
);

const logs :Workerd.Worker = (
  modules = [ (name = "logs.js", esModule = embed "logs.js") ],
  compatibilityDate = "2026-10-01",
  bindings = [ (name = "APP", service = "app"), (name = "RUNNER_SECRET", fromEnvironment = "RUNNER_SECRET") ],
  globalOutbound = "app",
);
