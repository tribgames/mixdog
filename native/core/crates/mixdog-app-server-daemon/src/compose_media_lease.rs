//! The relay media lane's sources (`remote-relay-media.ts`: `gallerySource`, `downloadSource`, `leasedMediaFile`), over the
//! workspace and the media domain:
//!
//! - `gallery`: an asset's original or rendition, resolved by the media domain (`resolveMediaFile`, the rendition built when it is
//!   wanted) and opened again the way `openAuthorizedFile(path, dirname(path))` opens it;
//! - `download`: a phone's file-download lease, by the media id `transfer/beginRead` told the phone, read through the transfer table
//!   for the device it belongs to;
//! - `project_file`: the lease `projectFs/previewFile` mints for a phone's image, audio or video.

use std::sync::Arc;

use async_trait::async_trait;
use mixdog_remote::media::{ByteSource, LeaseGuard, MediaSources, SourceFailure};
use mixdog_services::media::MediaService;
use mixdog_workspace::media_lease::{DownloadFile, LeasedFile};
use mixdog_workspace::service::WorkspaceService;

pub struct WorkspaceMediaSources {
    workspace: Arc<WorkspaceService>,
    media: Arc<MediaService>,
}

impl WorkspaceMediaSources {
    pub fn new(workspace: Arc<WorkspaceService>, media: Arc<MediaService>) -> Self {
        Self { workspace, media }
    }
}

struct FileBytes(LeasedFile);

#[async_trait]
impl ByteSource for FileBytes {
    fn size(&self) -> u64 {
        self.0.size()
    }

    fn mime(&self) -> String {
        self.0.mime().to_owned()
    }

    fn version(&self) -> Option<String> {
        Some(self.0.version().to_owned())
    }

    async fn read(&mut self, offset: u64, length: usize) -> std::io::Result<Vec<u8>> {
        self.0.read(offset, length).await
    }

    fn lease_guard(&self) -> Option<LeaseGuard> {
        self.0.lease().map(|lease| LeaseGuard { commit: lease.commit, ended: lease.ended })
    }
}

struct LeaseBytes(DownloadFile);

#[async_trait]
impl ByteSource for LeaseBytes {
    fn size(&self) -> u64 {
        self.0.size()
    }

    fn mime(&self) -> String {
        self.0.mime().to_owned()
    }

    fn version(&self) -> Option<String> {
        Some(self.0.version().to_owned())
    }

    async fn read(&mut self, offset: u64, length: usize) -> std::io::Result<Vec<u8>> {
        self.0.read(offset, length).await
    }

    fn lease_guard(&self) -> Option<LeaseGuard> {
        let lease = self.0.lease();
        Some(LeaseGuard { commit: lease.commit, ended: lease.ended })
    }
}

#[async_trait]
impl MediaSources for WorkspaceMediaSources {
    async fn gallery(&self, asset_id: &str, variant: &str) -> Result<Option<Box<dyn ByteSource>>, SourceFailure> {
        let resolved = self.media.lane_file(asset_id, variant).await.map_err(|_| SourceFailure::Other)?;
        let Some((path, mime)) = resolved else { return Ok(None) };
        Ok(self.workspace.open_gallery_file(path, mime).await.map(|file| Box::new(FileBytes(file)) as Box<dyn ByteSource>))
    }

    async fn download(&self, asset_id: &str, device: &str) -> Option<Box<dyn ByteSource>> {
        let file = self.workspace.download_file(device, asset_id)?;
        Some(Box::new(LeaseBytes(file)))
    }

    async fn project_file(&self, asset_id: &str, device: &str) -> Option<Box<dyn ByteSource>> {
        let file = self.workspace.project_leases().open(asset_id, device).await?;
        Some(Box::new(FileBytes(file)))
    }
}
