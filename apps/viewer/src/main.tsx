import { render } from "preact";
import { LocationProvider, Route, Router } from "preact-iso";
import { Home } from "./routes/home.tsx";
import { NotFound } from "./routes/not-found.tsx";
import "./styles/tokens.css";
import "./styles/base.css";

function App() {
  return (
    <LocationProvider>
      <Router>
        <Route path="/" component={Home} />
        <Route default component={NotFound} />
      </Router>
    </LocationProvider>
  );
}

render(<App />, document.getElementById("app") as HTMLElement);
