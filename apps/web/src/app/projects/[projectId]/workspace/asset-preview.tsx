"use client";

import { useState } from "react";
import Icon from "./workbench-icon";

export default function AssetPreview({ projectID, file }: { projectID: string; file: { id: string; name: string; generation: string; byte_size?: number; media_type?: string } }) {
 const [failed, setFailed] = useState(false);
 const url = `/api/v1/projects/${projectID}/files/${file.id}/asset?generation=${file.generation}`;
 const image = ["image/png", "image/jpeg", "image/gif", "image/webp"].includes(file.media_type ?? "");
 const size = file.byte_size ?? 0;
 return <section className="asset-preview" aria-label="File preview"><div className="asset-toolbar"><span>{file.name}</span><a className="button-link" href={url} download={file.name}><Icon name="download" size={14} />Download original</a></div>
  {image && !failed ? <div className="asset-image"><img src={`${url}&preview=1`} alt={file.name} onError={() => setFailed(true)} /></div> : <div className="asset-placeholder"><Icon name="file" size={45} /><h2>{file.name}</h2><p>{file.media_type ?? "Binary file"} · {size < 1024 ? `${size} B` : size < 1048576 ? `${(size / 1024).toFixed(1)} KiB` : `${(size / 1048576).toFixed(1)} MiB`}</p><p>{failed ? "Image preview is unavailable. Download the original file." : "This file is stored in its original format. Download it to open it in a compatible app."}</p><a className="button-link" href={url} download={file.name}>Download file</a></div>}
  <p className="asset-footnote">Original bytes are included in checkpoints and workspace sync. Binary and large files are not collaboratively text-edited.</p>
 </section>;
}
