fn spawn_egress(
    name: &'static str,
    sender: IpcSender<WirePacket>,
    inbox: Receiver<WirePacket>,
) -> JoinHandle<()> {
    thread::Builder::new()
        .name(name.into())
        .spawn(move || {
            while let Ok(packet) = inbox.recv() {
                if sender.send(packet).is_err() {
                    break;
                }
            }
        })
        .expect("IPC egress thread must start")
}
