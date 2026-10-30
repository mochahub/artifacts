import { render } from "preact";
import { LocationProvider, Route, Router } from "preact-iso";
import { AlmostReady } from "./routes/almost-ready.tsx";
import { Device } from "./routes/device.tsx";
import { Home } from "./routes/home.tsx";
import { NotFound } from "./routes/not-found.tsx";
import { Reset } from "./routes/reset.tsx";
import { SignIn } from "./routes/sign-in.tsx";
import { boot, bootFailed, meta, ready } from "./session.ts";
import "./styles/tokens.css";
import "./styles/base.css";
import "./styles/kit.css";

function App() {
  if (!ready.value) return null;
  if (bootFailed.value) {
    return (
      <main class="screen">
        <h1 class="h1 m">The server isn't answering</h1>
      </main>
    );
  }
  // In setup mode, every route renders the same page (06).
  if (!meta.value?.orgName) return <AlmostReady />;
  return (
    <LocationProvider>
      <Router>
        <Route path="/" component={Home} />
        <Route path="/sign-in" component={SignIn} />
        <Route path="/device" component={Device} />
        <Route path="/reset/:token" component={Reset} />
        <Route default component={NotFound} />
      </Router>
    </LocationProvider>
  );
}

boot();
render(<App />, document.getElementById("app") as HTMLElement);
