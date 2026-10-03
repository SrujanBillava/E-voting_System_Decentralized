import { Link } from "react-router-dom";
import { usePageTitle } from "../../components/useRouteFocus";

export default function NotFoundPage() {
  usePageTitle("Page not found");
  return (
    <div className="container stack">
      <div className="page-head">
        <p className="eyebrow">Error 404</p>
        <h1 className="h1">Page not found</h1>
        <p className="lede">There is no page at this address.</p>
      </div>
      <div className="actions">
        <Link className="btn btn-primary" to="/">
          Go to the start
        </Link>
      </div>
    </div>
  );
}
