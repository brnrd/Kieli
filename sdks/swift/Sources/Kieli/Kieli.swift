import Foundation
#if canImport(FoundationNetworking)
import FoundationNetworking
#endif

private struct Relation: Codable, Sendable {let operand:String;let mod:Double;let not:Bool;let ranges:[[Double]]}
private struct Node: Codable, Sendable {let type:String;let value:String?;let offset:Double?;let ordinal:Bool?;let options:[String:[Node]]?}
private struct Message: Codable, Sendable {let value:String;let nodes:[Node]}
private struct Bundle: Codable, Sendable {let schema:Int;let project:String;let locale:String;let release:String;let rules:[String:[String:[[Relation]]]];let messages:[String:Message]}
private struct Cache: Codable, Sendable {let endpoint:String;let etag:String;let bundle:Bundle}
private enum Failure:Error {case invalid,tooLarge,http(Int),format}

// A new serial URLSession delegate owns each bounded download. It never follows
// redirects, so the delivery credential cannot be forwarded to another origin.
private final class Download:NSObject,URLSessionDataDelegate,@unchecked Sendable {
    private var continuation:CheckedContinuation<(Data,HTTPURLResponse),Error>?
    private var body=Data(); private var response:HTTPURLResponse?;private var failure:Error?
    static func fetch(_ request:URLRequest) async throws -> (Data,HTTPURLResponse) {
        let delegate=Download()
        return try await withCheckedThrowingContinuation { continuation in
            delegate.continuation=continuation
            let config=URLSessionConfiguration.ephemeral
            config.timeoutIntervalForRequest=10;config.timeoutIntervalForResource=15
            config.httpCookieStorage=nil;config.urlCache=nil
            let queue=OperationQueue();queue.maxConcurrentOperationCount=1
            let session=URLSession(configuration:config,delegate:delegate,delegateQueue:queue)
            session.dataTask(with:request).resume()
        }
    }
    func urlSession(_ session:URLSession,task:URLSessionTask,willPerformHTTPRedirection response:HTTPURLResponse,newRequest request:URLRequest,completionHandler:@escaping(URLRequest?)->Void) {completionHandler(nil)}
    func urlSession(_ session:URLSession,dataTask:URLSessionDataTask,didReceive response:URLResponse,completionHandler:@escaping(URLSession.ResponseDisposition)->Void) {
        guard let http=response as? HTTPURLResponse,response.expectedContentLength<=2*1024*1024 else {failure=Failure.tooLarge;completionHandler(.cancel);return}
        self.response=http;completionHandler(.allow)
    }
    func urlSession(_ session:URLSession,dataTask:URLSessionDataTask,didReceive data:Data) {
        guard body.count+data.count<=2*1024*1024 else {failure=Failure.tooLarge;dataTask.cancel();return};body.append(data)
    }
    func urlSession(_ session:URLSession,task:URLSessionTask,didCompleteWithError error:Error?) {
        defer {continuation=nil;session.finishTasksAndInvalidate()}
        if let error=failure ?? error {continuation?.resume(throwing:error)}
        else if let response=response {continuation?.resume(returning:(body,response))}
        else {continuation?.resume(throwing:Failure.invalid)}
    }
}

/// Own one client per project, language and channel. Call refresh at app launch.
/// Delivery keys are public read credentials. Never put export or MCP tokens here.
public actor KieliClient {
    private let endpoint:URL;private let deliveryKey:String;private let cacheURL:URL
    private let project:String;private let locale:String
    private var current:Cache?
    private var refreshing=false
    public init(baseURL:URL,project:String,locale:String,deliveryKey:String,cacheDirectory:URL,channel:String="production") throws {
        guard baseURL.scheme=="https",baseURL.user==nil,baseURL.password==nil,baseURL.query==nil,baseURL.fragment==nil,
              baseURL.path=="" || baseURL.path=="/",["production","preview"].contains(channel),
              project.range(of:"^[a-z0-9][a-z0-9-]{0,47}$",options:.regularExpression) != nil,
              locale.range(of:"^[A-Za-z0-9-]{2,50}$",options:.regularExpression) != nil,
              deliveryKey.range(of:"^[A-Za-z0-9_.-]{20,200}$",options:.regularExpression) != nil else {throw Failure.invalid}
        self.project=project;self.locale=locale;self.deliveryKey=deliveryKey
        var url=URLComponents(url:baseURL.appendingPathComponent("ota/\(project)/\(locale)"),resolvingAgainstBaseURL:false)!
        url.queryItems=[URLQueryItem(name:"channel",value:channel)];endpoint=url.url!
        try FileManager.default.createDirectory(at:cacheDirectory,withIntermediateDirectories:true)
        cacheURL=cacheDirectory.appendingPathComponent("kieli-\(project)-\(locale)-\(channel).json")
        let size=(try? cacheURL.resourceValues(forKeys:[.fileSizeKey]).fileSize) ?? Int.max
        if size<=3*1024*1024,let data=try? Data(contentsOf:cacheURL),let cache=try? JSONDecoder().decode(Cache.self,from:data),cache.endpoint==endpoint.absoluteString,cache.bundle.schema==1,cache.bundle.project==project,cache.bundle.locale==locale {current=cache}
    }
    /// False means no new bundle was installed. The previous cache stays usable.
    @discardableResult public func refresh() async -> Bool {
        if refreshing {return false};refreshing=true;defer {refreshing=false}
        do {
            var request=URLRequest(url:endpoint);request.setValue("Bearer \(deliveryKey)",forHTTPHeaderField:"Authorization")
            request.setValue(current?.etag,forHTTPHeaderField:"If-None-Match")
            let (data,response)=try await Download.fetch(request)
            if response.statusCode==304 {return false}
            guard response.statusCode==200 else {throw Failure.http(response.statusCode)}
            let bundle=try JSONDecoder().decode(Bundle.self,from:data)
            guard bundle.schema==1,bundle.project==project,bundle.locale==locale,bundle.messages.count<=50000 else {throw Failure.invalid}
            let cache=Cache(endpoint:endpoint.absoluteString,etag:response.value(forHTTPHeaderField:"ETag") ?? "",bundle:bundle)
            try JSONEncoder().encode(cache).write(to:cacheURL,options:.atomic)
            current=cache;return true
        } catch {return false}
    }
    /// Supply numeric plural arguments as decimal strings, e.g. ["count":"3"].
    public func text(_ key:String,fallback:String,arguments:[String:String]=[:]) -> String {
        guard let bundle=current?.bundle,let message=bundle.messages[key] else {return fallback}
        return (try? render(message.nodes,arguments,bundle,nil,0)) ?? fallback
    }
    private func render(_ nodes:[Node],_ args:[String:String],_ bundle:Bundle,_ pound:Double?,_ depth:Int) throws -> String {
        guard depth<=20 else {throw Failure.format}
        var result=""
        for node in nodes {
            switch node.type {
            case "text": result += node.value ?? ""
            case "argument": guard let value=args[node.value ?? ""] else {throw Failure.format};result += value
            case "pound": guard let value=pound else {throw Failure.format};let formatter=NumberFormatter();formatter.locale=Locale(identifier:locale);formatter.numberStyle = .decimal;formatter.maximumFractionDigits=9;result += formatter.string(from:NSNumber(value:value)) ?? String(value)
            case "select": guard let value=args[node.value ?? ""],let options=node.options,let selected=options[value] ?? options["other"] else {throw Failure.format};result += try render(selected,args,bundle,pound,depth+1)
            case "plural":
                guard let raw=args[node.value ?? ""],raw.range(of:"^-?[0-9]{1,13}(\\.[0-9]{1,9})?$",options:.regularExpression) != nil,let number=Double(raw),number.isFinite,abs(number)<=1e12,let options=node.options else {throw Failure.format}
                let offset=node.offset ?? 0;let category=try select(number-offset,bundle.rules[node.ordinal == true ? "ordinal":"cardinal"] ?? [:])
                let exact=options.first(where:{$0.key.hasPrefix("=") && Double($0.key.dropFirst())==number})?.value
                guard let selected=exact ?? options[category] ?? options["other"] else {throw Failure.format}
                result += try render(selected,args,bundle,number-offset,depth+1)
            default:throw Failure.format
            }
            guard result.count<=100000 else {throw Failure.tooLarge}
        }
        return result
    }
    private func select(_ input:Double,_ rules:[String:[[Relation]]]) throws -> String {
        let number=abs(input)
        var decimal=String(format:"%.9f",locale:Locale(identifier:"en_US_POSIX"),number)
        while decimal.last=="0" {decimal.removeLast()};if decimal.last=="." {decimal.removeLast()}
        let fraction=decimal.split(separator:".").dropFirst().first.map(String.init) ?? ""
        let trimmed=fraction.replacingOccurrences(of:"0+$",with:"",options:.regularExpression)
        let operands:[String:Double]=["n":number,"i":floor(number),"v":Double(fraction.count),"w":Double(trimmed.count),"f":Double(fraction) ?? 0,"t":Double(trimmed) ?? 0,"e":0,"c":0]
        for category in ["zero","one","two","few","many"] {
            guard let groups=rules[category] else {continue}
            if try groups.contains(where:{group in try group.allSatisfy { relation in
                guard var value=operands[relation.operand],relation.ranges.allSatisfy({$0.count==2}) else {throw Failure.format}
                if relation.mod>0 {value=value.truncatingRemainder(dividingBy:relation.mod)}
                let matches=value.rounded(.towardZero)==value && relation.ranges.contains(where:{$0[0]<=value && value<=$0[1]})
                return relation.not ? !matches:matches
            }}) {return category}
        }
        return "other"
    }
}
