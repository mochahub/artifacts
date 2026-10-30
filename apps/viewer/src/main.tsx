import { render } from "preact";
import { ErrorBoundary, LocationProvider, Route, Router } from "preact-iso";
import { Activity } from "./routes/activity.tsx";
import { AlmostReady } from "./routes/almost-ready.tsx";
import { ArtifactPage } from "./routes/artifact.tsx";
import { ComparePage } from "./routes/compare.tsx";
import { RecentlyDeleted } from "./routes/deleted-list.tsx";
import { Device } from "./routes/device.tsx";
import { GuestLanding } from "./routes/guest.tsx";
import { Home } from "./routes/home.tsx";
import { Join } from "./routes/join.tsx";
import { NotFound } from "./routes/not-found.tsx";
import { PageRoute } from "./routes/page.tsx";
import { ProjectPage } from "./routes/project.tsx";
import { Projects } from "./routes/projects.tsx";
import { Reset } from "./routes/reset.tsx";
import { Settings } from "./routes/settings.tsx";
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
      <ErrorBoundary>
        <Router>
          <Route path="/" component={Home} />
          <Route path="/projects" component={Projects} />
          <Route path="/activity" component={Activity} />
          <Route path="/sign-in" component={SignIn} />
          <Route path="/device" component={Device} />
          <Route path="/reset/:token" component={Reset} />
          <Route path="/join/:token" component={Join} />
          <Route path="/s/:token" component={GuestLanding} />
          <Route path="/settings" component={Settings} />
          <Route path="/settings/deleted" component={RecentlyDeleted} />
          <Route path="/settings/:section" component={Settings} />
          <Route path="/:project" component={ProjectPage} />
          <Route path="/:project/:artifact" component={ArtifactPage} />
          <Route path="/:project/:artifact/compare" component={ComparePage} />
          <Route path="/:project/:artifact/v/:n" component={PageRoute} />
          <Route path="/:project/:artifact/v/:n/:page" component={PageRoute} />
          <Route path="/:project/:artifact/:page" component={PageRoute} />
          <Route default component={NotFound} />
        </Router>
      </ErrorBoundary>
    </LocationProvider>
  );
}

boot();
render(<App />, document.getElementById("app") as HTMLElement);
