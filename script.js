
let map;
let marker;
let geocoder;
let qr;

const parishMap = {
  "Saint George": "GE",
  "Saint Andrew": "AN",
  "Saint David": "DA",
  "Saint Patrick": "PA",
  "Saint Mark": "MA",
  "Saint John": "JO",
  "Carriacou": "CA",
  "Petite Martinique": "PM"
};

function initMap() {

  const grenada = { lat: 12.1165, lng: -61.6790 };

  map = new google.maps.Map(document.getElementById("map"), {
    center: grenada,
    zoom: 10,
    mapTypeId: "roadmap"
  });

  geocoder = new google.maps.Geocoder();

  map.addListener("click", function(event){

    const lat = event.latLng.lat();
    const lng = event.latLng.lng();

    if(marker){
      marker.setPosition(event.latLng);
    }else{
      marker = new google.maps.Marker({
        position:event.latLng,
        map:map
      });
    }

    updateLocation(lat,lng);

  });

}

function updateLocation(lat,lng){

  document.getElementById("coord-display").innerText =
    lat.toFixed(6) + ", " + lng.toFixed(6);

  geocoder.geocode({ location: {lat:lat,lng:lng} }, function(results,status){

    let parishName = "Unknown";
    let parishCode = "UN";

    if(status === "OK" && results[0]){

      for(const comp of results[0].address_components){

        if(comp.types.includes("administrative_area_level_1") ||
           comp.types.includes("administrative_area_level_2")){

          parishName = comp.long_name;

          if(parishMap[parishName]){
            parishCode = parishMap[parishName];
          }

        }

      }

    }

    document.getElementById("parish-display").innerText = parishName;

    generateCode(parishCode,lat,lng);

  });

}

function generateCode(parish,lat,lng){

  const grid =
    Math.abs(Math.floor(lat*1000)).toString().padStart(3,"0") +
    Math.abs(Math.floor(lng*1000)).toString().padStart(3,"0");

  const code = "GN-" + parish + "-" + grid;

  document.getElementById("location-code").innerText = code;

  generateQR(lat,lng);

}

function generateQR(lat,lng){

  const url =
    "https://www.google.com/maps?q=" + lat + "," + lng;

  const canvas = document.getElementById("qr-canvas");

  canvas.innerHTML="";

  new QRCode(canvas,{
    text:url,
    width:160,
    height:160
  });

}
