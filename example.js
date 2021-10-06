import Comm from "./Comms.js";

'use strict';

function addElems(comm, data) {
    console.log(data);
    document.body.appendChild(data.video);
    document.body.appendChild(data.audio);
}


$(document).ready(() => {

    const lv = $("#localVideo");
    const no_video_image = "noCam.png";
    const code = "Rrv8qPaCmE9Jkyg0";
    const room_code = "Test Room"
    
    const comm = new Comm(lv, no_video_image, {"makeRemoteElements": addElems});
    document.comm = comm;

    $("#join").click(() => {

        const name = $("#name").val();
        comm.join(code, room_code, name);

    });

    comm.init();

});