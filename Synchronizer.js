// https://stackoverflow.com/questions/23013573/swap-key-with-value-json/54207992#54207992
const reverseDict = (o, r = {}) => Object.keys(o).map(x => r[o[x]] = x) && r;


// https://github.com/30-seconds/30-seconds-of-code/blob/master/snippets/chunk.md
const chunk = (arr, size) =>
  Array.from({ length: Math.ceil(arr.length / size) }, (v, i) =>
    arr.slice(i * size, i * size + size)
  );

// emulate python's pop
const dictPop = (obj, key, def) => {
  if (key in obj) {
    let val = obj[key];
    delete obj[key];
    return val;
  } else if (def !== undefined) {
    return def;
  } else {
    throw `key ${key} not in dictionary`
  }
}

// https://stackoverflow.com/questions/7905929/how-to-test-valid-uuid-guid
const isUUID = (uuid) => {
  let re = /^[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12}$/;
  return re.test(uuid)
}

const rDeviceTokenKey = "__REMARKABLE_DEVICE_TOKEN__";
const rDeviceIdKey = "__REMARKABLE_DEVICE_ID__";
const availableModes = ["mirror", "update"];

/*  Main work here. Walks Google Drive then uploads 
 folder and files to Remarkable cloud storage. Currently
 only uploads PDFs/EPUBs. There appears to be a limitation
 with Remarkable that files must be less than 50MB so
 files greater than this size are filtered out.

Arguments:

rOneTimeCode - One time pass code from Remarkable that can typically
               be generated at https://my.remarkable.com/connect/mobile.
gdFolderSearchParams - Google Drive search SDK string or folder id.
rRootFolderName - The root folder in Remarkable device. Currently this
                  must already exist on your device. This can be a remarkable
                  folder GUID if you know it.
syncMode - "mirror" or "update" (default). Mirroring will delete files
           in Remarkebale cloud that have been removed from Google Drive.
gdFolderSkipList - Optional list of folder names to skip from syncing
forceUpdateFunc - Optional function of obj dictionaries, the first generated
                  from Google Drive, the second from Remarkable storage. The
                  function returns true/false and determines whether you 
                  wish to bump up the version and force push.

*/
class Synchronizer {
  constructor(rOneTimeCode, gdFolderSearchParams, rRootFolderName, syncMode = "update", gdFolderSkipList = [], forceUpdateFunc = null) {

    // try finding google folder by id first
    try {
      this.gdFolder = DriveApp.getFolderById(gdFolderSearchParams);
    } catch (err) {
      let gdSearchFolders = DriveApp.searchFolders(gdFolderSearchParams);
      if (gdSearchFolders.hasNext()) {
        this.gdFolder = gdSearchFolders.next();
      } else {
        throw `Could not find Google Drive folder using search params: ${gdFolderSearchParams}`;
      }
    }

    this.gdFolderSkipList = gdFolderSkipList;
    this.forceUpdateFunc = forceUpdateFunc;
    // we borrow terminology from https://freefilesync.org/manual.php?topic=synchronization-settings
    if (!availableModes.includes(syncMode)) {
      throw `syncMode '${syncMode}' not supported, try one from: ${availableModes}`
    }
    this.syncMode = syncMode;

    // for limits see https://developers.google.com/apps-script/guides/services/quotas
    this.userProps = PropertiesService.getUserProperties();

    // these are read from and cached to this.userProps
    this.gdIdToUUID = this.userProps.getProperties();

    // pop off keys not used for storing id/uuid mappings
    let rDeviceToken = dictPop(this.gdIdToUUID, rDeviceTokenKey, null);
    let rDeviceId = dictPop(this.gdIdToUUID, rDeviceIdKey, null);

    // for storing reverse map
    this.UUIDToGdId = reverseDict(this.gdIdToUUID);

    // initialize remarkable api
    if (rDeviceToken === null) {
      this.rApiClient = new RemarkableAPI(null, null, rOneTimeCode);
      this.userProps.setProperty(rDeviceTokenKey, this.rApiClient.deviceToken);
      this.userProps.setProperty(rDeviceIdKey, this.rApiClient.deviceId);
    } else {
      this.rApiClient = new RemarkableAPI(rDeviceId, rDeviceToken);
    }

    // prep some common vars
    this.rDocList = this.rApiClient.listDocs();
    Logger.log(`Found ${this.rDocList.length} items in Remarkable Cloud`);

    // for debugging - dump doc list as json in root google drive folder
    //DriveApp.createFile('remarkableDocList.json', JSON.stringify(this.rDocList));

    // create reverse dictionary
    this.rDocId2Ent = {}
    for (const [ix, doc] of this.rDocList.entries()) {
      this.rDocId2Ent[doc["ID"]] = ix;
    }

    // find root folder id
    if (isUUID(rRootFolderName)) {
      this.rRootFolderId = rRootFolderName;
    } else {
      let filteredDocs = this.rDocList.filter((r) => r["VissibleName"] == rRootFolderName);
      if (filteredDocs.length > 0) {
        this.rRootFolderId = filteredDocs[0]["ID"];
      }
      else {
        // TODO if can't find it, create folder at top level with rRootFolderName
        throw `Cannot find root file '${rRootFolderName}'`;
      }
    }
    Logger.log(`Mapped '${rRootFolderName}' to ID '${this.rRootFolderId}'`);
  }

  getUUID(gdId) {
    if (!(gdId in this.gdIdToUUID)) {
      let uuid = Utilities.getUuid();
      this.gdIdToUUID[gdId] = uuid;
      this.UUIDToGdId[uuid] = gdId;
    }
    return this.gdIdToUUID[gdId];
  }

  generateZipBlob(gdFileId) {
    let uuid = this.getUUID(gdFileId);
    let gdFileObj = DriveApp.getFileById(gdFileId);
    let gdFileMT = gdFileObj.getMimeType();

    if (gdFileMT == MimeType.SHORTCUT) {
      Logger.log(`Resolving shortcut to target file '${gdFileObj.getName()}'`);
      gdFileObj = DriveApp.getFileById(gdFileObj.getTargetId());
      gdFileMT = gdFileObj.getMimeType();
    }
    
    let zipBlob = null;

    if (gdFileMT == MimeType.FOLDER) {
      let contentBlob = Utilities.newBlob(JSON.stringify({})).setName(`${uuid}.content`);
      zipBlob = Utilities.zip([contentBlob]);
    } else {
      let gdFileExt = gdFileObj.getName().split('.').pop();
      let gdFileBlob = gdFileObj.getBlob().setName(`${uuid}.${gdFileExt}`);
      let pdBlob = Utilities.newBlob("").setName(`${uuid}.pagedata`);
      let contentData = {
        'extraMetadata': {},
        'fileType': gdFileExt,
        'lastOpenedPage': 0,
        'lineHeight': -1,
        'margins': 100,
        'pageCount': 0, // we don't know this, but it seems the reMarkable can count
        'textScale': 1,
        'transform': {} // no idea how to fill this, but it seems optional
      }
      let contentBlob = Utilities.newBlob(JSON.stringify(contentData)).setName(`${uuid}.content`);
      zipBlob = Utilities.zip([gdFileBlob, pdBlob, contentBlob]);
    }

    //DriveApp.createFile(zipBlob.setName(`rem-${uuid}.zip`)); // to debug/examine
    return zipBlob;
  }

  gdWalk(top, rParentId) {
    if (this.gdFolderSkipList.includes(top.getName())) {
      Logger.log(`Skipping Google Drive sub folder '${top.getName()}'`);
      return;
    }
    Logger.log(`Scanning Google Drive sub folder '${top.getName()}'`)

    let files = top.getFiles();
    while (files.hasNext()) {
      let file = files.next();
      this.uploadDocList.push({
        "ID": this.getUUID(file.getId()),
        "Type": "DocumentType",
        "Parent": rParentId,
        "VissibleName": file.getName(),
        "Version": 1,
        "_gdId": file.getId(),
        "_gdSize": file.getSize(),
      });
    }

    let topUUID = this.getUUID(top.getId());
    let folders = top.getFolders();
    while (folders.hasNext()) {
      let folder = folders.next();
      let folderUUID = this.getUUID(folder);
      this.uploadDocList.push({
        "ID": folderUUID,
        "Type": "CollectionType",
        "Parent": topUUID,
        "VissibleName": folder.getName(),
        "Version": 1,
        "_gdId": folder.getId(),
        "_gdSize": folder.getSize(),
      });
      this.gdWalk(folder, topUUID);
    }

  }

  // filter for upload list
  _needsUpdate(r) {
    if (r["ID"] in this.rDocId2Ent) {
      // update if parent or name differs
      let ix = this.rDocId2Ent[r["ID"]];
      let s = this.rDocList[ix];

      // force update
      if (this.forceUpdateFunc !== null && this.forceUpdateFunc(r, s)) {
        // bump up to server version 
        r["Version"] = s["Version"] + 1;
        return true;
      }

      // verbose so can set breakpoints
      if (s["Parent"] != r["Parent"] || s["VissibleName"] != r["VissibleName"]) {
        // bump up to server version 
        r["Version"] = s["Version"] + 1;
        return true;
      } else {
        return false;
      }
    }
    else {
      // 50MB = 50 * 1024*1024 = 52428800
      if (r["Type"] == "DocumentType" 
          && (r["VissibleName"].endsWith("pdf") || r["VissibleName"].endsWith("epub")) 
          && r["_gdSize"] <= 52428800) {
        return true;
      } else if (r["Type"] == "CollectionType") {
        return true;
      } else {
        return false;
      }
    }
  }

  rAllDescendantIds() {
    // returns list of IDs all decendants
    let collected = [];
    let that = this;
    function _walkDocList(parentId) {
      collected.push(parentId);
      let children = that.rDocList.filter((r) => r.Parent == parentId).map((r) => _walkDocList(r.ID));
    }
    _walkDocList(this.rRootFolderId);
    // remove the parentId (this typically won't come from Google Drive)
    return collected.filter(x => x !== this.rRootFolderId);
  }

  run() {
    try {
      // store all objects in this
      this.uploadDocList = [];

      // generate list from google drive
      Logger.log(`Scanning Google Drive folder '${this.gdFolder.getName()}'..`)
      this.gdWalk(this.gdFolder, this.rRootFolderId);
      Logger.log(`Found ${this.uploadDocList.length} items in Google Drive folder.`)

      // for debugging - dump upload doc list as json in root google drive folder
      //DriveApp.createFile('googleDriveDocList.json', JSON.stringify(this.uploadDocList));

      // save new user properties
      this.userProps.setProperties(this.gdIdToUUID);

      // remove files from device no longer in google drive
      if (this.syncMode === "mirror") {
        Logger.log("In mirror mode. Will delete files on Remarkable not on Google Drive.");
        let rDescIds = new Set(this.rAllDescendantIds());
        let gdIds = new Set(this.uploadDocList.map((r) => r.ID));
        let diff = rDescIds.difference(gdIds);
        let deleteList = this.rDocList.filter((r) => diff.has(r.ID));
        deleteList.forEach((r) => {
          Logger.log(`Adding for deletion: ${r["VissibleName"]}`);
        });
        if (deleteList.length > 0) {
          Logger.log(`Deleting ${deleteList.length} docs that no longer exist in Google Drive`);
          this.rApiClient.delete(deleteList);
        }
      }

      // filter those that need update
      let updateDocList = this.uploadDocList.filter((r) => this._needsUpdate(r));
      Logger.log(`Updating ${updateDocList.length} documents and folders..`)

      // chunk into 5 files at a time a loop
      for (const uploadDocChunk of chunk(updateDocList, 5)) {
        Logger.info(`Processing chunk of size ${uploadDocChunk.length}..`)

        // extract data for registration
        let uploadRequestResults = this.rApiClient.uploadRequest(uploadDocChunk);

        // upload files
        let deleteDocList = [];
        for (const doc of uploadRequestResults) {
          if (doc["Success"]) {
            try {
              let gdFileId = this.UUIDToGdId[doc["ID"]];
              let gdFileObj = DriveApp.getFileById(gdFileId);
              Logger.log(`Attempting to upload '${gdFileObj.getName()}'; size ${gdFileObj.getSize()} bytes`);
              let gdFileBlob = this.generateZipBlob(gdFileId);
              Logger.log(`Generated Remarkable zip blob for '${gdFileObj.getName()}'`);
              this.rApiClient.blobUpload(doc["BlobURLPut"], gdFileBlob);
              Logger.log(`Uploaded '${gdFileObj.getName()}'`);
            }
            catch (err) {
              Logger.log(`Failed to upload '${doc["ID"]}': ${err}`);
              deleteDocList.push(doc);
            }
          }
        }

        // update metadata
        Logger.info("Updating meta data for chunk");
        let uploadUpdateStatusResults = this.rApiClient.uploadUpdateStatus(uploadDocChunk);
        for (const r of uploadUpdateStatusResults) {
          if (!r["Success"]) {
            let ix = this.rDocId2Ent[r["ID"]];
            let s = this.rDocList[ix];
            Logger.log(`Failed to update status '${s["VissibleName"]}': ${r["Message"]}`)
          }
        }

        // delete failed uploads
        // do this after meta data update to ensure version matches.
        if (deleteDocList.length > 0) {
          Logger.log(`Deleting ${deleteDocList.length} docs that failed to upload`);
          this.rApiClient.delete(deleteDocList);
        }

        Logger.info("Finished processing chunk.");
      }

      Logger.info("Finished running!");
    }
    catch (err) {
      Logger.log(`Finished run with error: ${err}`);
    }
  }

}
