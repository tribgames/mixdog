//! `/d/<deviceId>/...` (`lib/relay-static-gate.mjs`): the install and approval entry of one desktop. The id is a routing label,
//! never a credential: it opens the shell that asks for approval and nothing else.

use mixdog_rt::InteractiveIo;

use super::files::{StaticOptions, StaticResolution, send_device_manifest, send_static_file};
use super::headers::device_cookie_headers;
use crate::http1::util::end_text;
use crate::http1::{HeaderError, Request, ResponseWriter};
use crate::ids::is_routing_id;

/// What `parseDeviceRoute` returns for a path under `/d/`.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct DeviceRoute {
    pub device_id: String,
    /// The path had no trailing slash: relative asset and manifest hrefs in `index.html` only resolve inside the route when it
    /// ends in one.
    pub redirect: bool,
    /// The path inside the release: `/index.html` for the route itself.
    pub rest: String,
}

/// `parseDeviceRoute`: `^/d/([^/]+)(/.*)?$` with a routing id in the first group. `.` does not match a line terminator, so a
/// rest that holds one is no route.
pub fn parse_device_route(pathname: &str) -> Option<DeviceRoute> {
    let after = pathname.strip_prefix("/d/")?;
    let (id, rest) = after.find('/').map_or((after, ""), |at| after.split_at(at));
    if id.is_empty() || !is_routing_id(id) || rest.contains(['\n', '\r', '\u{2028}', '\u{2029}']) {
        return None;
    }
    Some(DeviceRoute {
        device_id: id.to_owned(),
        redirect: rest.is_empty(),
        rest: if rest.is_empty() || rest == "/" { "/index.html".to_owned() } else { rest.to_owned() },
    })
}

/// `serveDeviceRoute`: the shell scoped to one desktop. `resolution` is `route.rest` resolved in the release of that device.
/// The install captures `start_url`, so the manifest under a device route points back at the same route.
pub async fn serve_device_route(
    io: &InteractiveIo,
    route: &DeviceRoute,
    resolution: StaticResolution,
    request: &Request,
    response: &mut ResponseWriter,
) -> Result<(), HeaderError> {
    if route.redirect {
        response.write_head(301, &[("Location", format!("/d/{}/", route.device_id).as_str())])?;
        response.end(None);
        return Ok(());
    }
    if route.rest == "/manifest.webmanifest" {
        if let StaticResolution::Found(target) = &resolution
            && send_device_manifest(io, request, response, target, &route.device_id).await
        {
            return Ok(());
        }
        return end_text(response, 404, "Not found.", &[]);
    }
    match resolution {
        StaticResolution::Found(target) => {
            let cookies = device_cookie_headers(&route.device_id, request.encrypted);
            send_static_file(io, request, response, &target, &cookies, StaticOptions::default()).await;
            Ok(())
        }
        StaticResolution::Forbidden => bare(response, 403),
        StaticResolution::Missing => bare(response, 404),
    }
}

/// `writeHead(status).end()`.
pub(super) fn bare(response: &mut ResponseWriter, status: u16) -> Result<(), HeaderError> {
    response.write_head(status, &[])?;
    response.end(None);
    Ok(())
}
